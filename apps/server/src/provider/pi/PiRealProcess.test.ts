import * as NodeServices from "@effect/platform-node/NodeServices";
import { PiSettings } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { checkPiProviderStatus } from "../Layers/PiProvider.ts";
import { discoverPiProviderContextViaRpc } from "../Layers/PiProvider.ts";
import { discoverPiRpc } from "./PiRpcDiscovery.ts";

const enabled = process.env.T3_PI_REAL_PROCESS_TESTS === "1";
const decodeSettings = Schema.decodeSync(PiSettings);

it.layer(NodeServices.layer)("Pi RPC real processes", (it) => {
  for (const input of [
    {
      name: "Pi",
      path: process.env.T3_PI_REAL_BINARY ?? "/Users/harsha/.local/bin/pi",
      dialect: "pi",
    },
    {
      name: "OMP",
      path: process.env.T3_OMP_REAL_BINARY ?? "/Users/harsha/.bun/bin/omp",
      dialect: "omp",
    },
  ] as const) {
    const name = `discovers models and commands from ${input.name}`;
    if (!enabled) {
      it.skip(name, () => undefined);
      continue;
    }
    it.effect(name, () =>
      Effect.gen(function* () {
        const settings = decodeSettings({ enabled: true, binaryPath: input.path });
        const direct = yield* discoverPiRpc(settings, process.cwd(), process.env);
        const snapshot = yield* checkPiProviderStatus(settings, process.cwd());
        const discovered = yield* discoverPiProviderContextViaRpc(
          settings,
          process.cwd(),
          process.env,
        );
        expect(snapshot.installed).toBe(true);
        expect(snapshot.version).toMatch(/^\d+\.\d+\.\d+$/u);
        expect(direct.codec.kind).toBe(input.dialect);
        expect(direct.models.length).toBeGreaterThan(0);
        expect(direct.commands.length).toBeGreaterThan(0);
        expect(discovered?.codec.kind).toBe(input.dialect);
        expect(discovered?.models.length).toBeGreaterThan(0);
        expect(discovered?.commands.length).toBeGreaterThan(0);
      }),
    );
  }
});
