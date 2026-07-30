import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { PiSettings } from "@t3tools/contracts";

import { buildInitialPiProviderSnapshot, checkPiProviderStatus } from "./PiProvider.ts";

const decodePiSettings = Schema.decodeSync(PiSettings);

// fake `pi`: `--version` exits 0; model discovery returns one provider-native model
const HEALTHY_PI_SCRIPT = [
  "#!/bin/sh",
  'case "$1" in',
  '  --version) printf "pi 0.80.9\\n"; exit 0 ;;',
  '  *) printf \'{"type":"response","command":"get_available_models","id":"pi-model-discovery","success":true,"data":{"models":[{"provider":"x","id":"y"}]}}\\n\'; exit 0 ;;',
  "esac",
  "",
].join("\n");
const NO_MODELS_PI_SCRIPT = HEALTHY_PI_SCRIPT.replace(
  '"models":[{"provider":"x","id":"y"}]',
  '"models":[]',
);
const HEALTHY_OMP_SCRIPT = HEALTHY_PI_SCRIPT.replace("pi 0.80.9", "omp/17.0.1");
const OLD_PI_SCRIPT = HEALTHY_PI_SCRIPT.replace("pi 0.80.9", "pi 0.80.6");
const OLD_OMP_SCRIPT = HEALTHY_PI_SCRIPT.replace("pi 0.80.9", "omp/17.0.0");
const RPC_FAILURE_PI_SCRIPT = [
  "#!/bin/sh",
  'case "$1" in',
  '  --version) printf "pi 0.80.9\\n"; exit 0 ;;',
  "  *) exit 1 ;;",
  "esac",
  "",
].join("\n");

describe("buildInitialPiProviderSnapshot", () => {
  it.effect("returns a disabled snapshot when settings.enabled is false", () =>
    Effect.gen(function* () {
      const snapshot = yield* buildInitialPiProviderSnapshot(decodePiSettings({ enabled: false }));
      expect(snapshot.enabled).toBe(false);
      expect(snapshot.status).toBe("disabled");
      expect(snapshot.installed).toBe(false);
      expect(snapshot.message).toContain("disabled");
    }),
  );

  it.effect("returns a pending snapshot when enabled", () =>
    Effect.gen(function* () {
      const snapshot = yield* buildInitialPiProviderSnapshot(decodePiSettings({ enabled: true }));
      expect(snapshot.enabled).toBe(true);
      expect(snapshot.installed).toBe(true);
      expect(snapshot.status).toBe("warning");
      expect(snapshot.version).toBeNull();
      expect(snapshot.message).toContain("Checking Pi");
      expect(snapshot.showInteractionModeToggle).toBe(false);
    }),
  );

  it.effect("appends custom models from settings to the catalog", () =>
    Effect.gen(function* () {
      const snapshot = yield* buildInitialPiProviderSnapshot(
        decodePiSettings({ enabled: true, customModels: ["anthropic/claude-custom"] }),
      );
      expect(snapshot.models.map((model) => model.slug)).toContain("anthropic/claude-custom");
      expect(
        snapshot.models.find((model) => model.slug === "anthropic/claude-custom")?.isCustom,
      ).toBe(true);
    }),
  );
});

it.layer(NodeServices.layer)("checkPiProviderStatus", (it) => {
  it.effect("reports the binary as missing when the binary path does not resolve", () =>
    Effect.gen(function* () {
      const snapshot = yield* checkPiProviderStatus(
        decodePiSettings({ enabled: true, binaryPath: "/definitely/not/installed/pi-binary" }),
        process.cwd(),
      );
      expect(snapshot.enabled).toBe(true);
      expect(snapshot.installed).toBe(false);
      expect(snapshot.status).toBe("error");
      expect(snapshot.message).toMatch(/not installed|not on PATH/);
    }),
  );

  it.effect("returns a disabled snapshot without probing when settings.enabled is false", () =>
    Effect.gen(function* () {
      const snapshot = yield* checkPiProviderStatus(
        decodePiSettings({ enabled: false }),
        process.cwd(),
      );
      expect(snapshot.enabled).toBe(false);
      expect(snapshot.status).toBe("disabled");
      expect(snapshot.installed).toBe(false);
    }),
  );

  it.effect("reports an installed CLI as unhealthy when --version exits non-zero", () =>
    Effect.gen(function* () {
      const snapshot = yield* Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-pi-version-" });
          const piPath = path.join(dir, "pi");
          yield* fs.writeFileString(
            piPath,
            ["#!/bin/sh", 'printf "pi error\\n" >&2', "exit 2", ""].join("\n"),
          );
          yield* fs.chmod(piPath, 0o755);

          return yield* checkPiProviderStatus(
            decodePiSettings({ enabled: true, binaryPath: piPath }),
            dir,
          );
        }),
      );

      expect(snapshot.enabled).toBe(true);
      expect(snapshot.installed).toBe(true);
      expect(snapshot.status).toBe("error");
      expect(typeof snapshot.message).toBe("string");
    }),
  );

  for (const [name, script] of [
    ["Pi", OLD_PI_SCRIPT],
    ["OMP", OLD_OMP_SCRIPT],
  ] as const) {
    it.effect(`rejects an unsupported ${name} protocol version`, () =>
      Effect.gen(function* () {
        const snapshot = yield* Effect.scoped(
          Effect.gen(function* () {
            const fs = yield* FileSystem.FileSystem;
            const path = yield* Path.Path;
            const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-pi-old-version-" });
            const binaryPath = path.join(dir, name.toLowerCase());
            yield* fs.writeFileString(binaryPath, script);
            yield* fs.chmod(binaryPath, 0o755);
            return yield* checkPiProviderStatus(
              decodePiSettings({ enabled: true, binaryPath }),
              dir,
            );
          }),
        );

        expect(snapshot.status).toBe("error");
        expect(snapshot.message).toMatch(/requires|upgrade/i);
      }),
    );
  }

  it.effect("reports ready/authenticated when models are available", () =>
    Effect.gen(function* () {
      const snapshot = yield* Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-pi-ready-" });
          const piPath = path.join(dir, "pi");
          yield* fs.writeFileString(piPath, HEALTHY_PI_SCRIPT);
          yield* fs.chmod(piPath, 0o755);
          return yield* checkPiProviderStatus(
            decodePiSettings({ enabled: true, binaryPath: piPath, customModels: ["custom/model"] }),
            dir,
          );
        }),
      );
      expect(snapshot.status).toBe("ready");
      expect(snapshot.auth.status).toBe("authenticated");
    }),
  );

  it.effect("accepts an OMP binary implementing the same RPC transport", () =>
    Effect.gen(function* () {
      const snapshot = yield* Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-omp-ready-" });
          const ompPath = path.join(dir, "omp");
          yield* fs.writeFileString(ompPath, HEALTHY_OMP_SCRIPT);
          yield* fs.chmod(ompPath, 0o755);
          return yield* checkPiProviderStatus(
            decodePiSettings({ enabled: true, binaryPath: ompPath }),
            dir,
          );
        }),
      );
      expect(snapshot.status).toBe("ready");
      expect(snapshot.auth.status).toBe("authenticated");
      expect(snapshot.version).toBe("17.0.1");
    }),
  );

  it.effect("degrades to warning/unknown when the CLI is healthy but no models are available", () =>
    Effect.gen(function* () {
      const snapshot = yield* Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-pi-nomodels-" });
          const piPath = path.join(dir, "pi");
          yield* fs.writeFileString(piPath, NO_MODELS_PI_SCRIPT);
          yield* fs.chmod(piPath, 0o755);
          return yield* checkPiProviderStatus(
            decodePiSettings({
              enabled: true,
              binaryPath: piPath,
              customModels: ["custom/model"],
            }),
            dir,
          );
        }),
      );
      expect(snapshot.status).toBe("warning");
      expect(snapshot.auth.status).toBe("unknown");
      expect(snapshot.message).toMatch(/no models/i);
    }),
  );

  it.effect("reports an RPC discovery failure instead of claiming the CLI has no models", () =>
    Effect.gen(function* () {
      const snapshot = yield* Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-pi-rpc-failure-" });
          const piPath = path.join(dir, "pi");
          yield* fs.writeFileString(piPath, RPC_FAILURE_PI_SCRIPT);
          yield* fs.chmod(piPath, 0o755);
          return yield* checkPiProviderStatus(
            decodePiSettings({ enabled: true, binaryPath: piPath }),
            dir,
          );
        }),
      );

      expect(snapshot.status).toBe("error");
      expect(snapshot.message).toMatch(/RPC model discovery failed/i);
    }),
  );
});
