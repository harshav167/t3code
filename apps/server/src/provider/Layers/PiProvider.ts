import {
  type ModelCapabilities,
  type PiSettings,
  type ServerProviderModel,
} from "@t3tools/contracts";
import { createModelCapabilities } from "@t3tools/shared/model";
import { compareSemverVersions } from "@t3tools/shared/semver";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import { ChildProcess } from "effect/unstable/process";

import {
  buildServerProvider,
  DEFAULT_TIMEOUT_MS,
  detailFromResult,
  isCommandMissingCause,
  parseGenericCliVersion,
  providerModelsFromSettings,
  spawnAndCollect,
} from "../providerSnapshot.ts";
import { piModelInfoToServerModel } from "../pi/PiModels.ts";
import type { PiCommandInventory } from "../pi/PiCommands.ts";
import { discoverPiRpc, type PiRpcDiscoveryResult } from "../pi/PiRpcDiscovery.ts";

const PI_PRESENTATION = {
  displayName: "Pi",
  badgeLabel: "Early Access",
  showInteractionModeToggle: false,
} as const;

const EMPTY_CAPABILITIES: ModelCapabilities = createModelCapabilities({ optionDescriptors: [] });

const PI_MODEL_DISCOVERY_TIMEOUT_MS = 30_000;
const MINIMUM_PI_VERSION = "0.80.7";
const MINIMUM_OMP_VERSION = "17.0.1";

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

const runPiVersion = (piSettings: PiSettings, environment: NodeJS.ProcessEnv) =>
  Effect.suspend(() => {
    const binaryPath = piSettings.binaryPath || "pi";
    return Effect.gen(function* () {
      const spawnCommand = yield* resolveSpawnCommand(binaryPath, ["--version"], {
        env: environment,
        extendEnv: true,
      });
      const command = ChildProcess.make(spawnCommand.command, spawnCommand.args, {
        env: environment,
        extendEnv: true,
        shell: spawnCommand.shell,
      });
      return yield* spawnAndCollect(binaryPath, command);
    });
  });

export const discoverPiProviderContextViaRpc = Effect.fn("discoverPiProviderContextViaRpc")(
  function* (piSettings: PiSettings, cwd: string, environment: NodeJS.ProcessEnv) {
    return yield* discoverPiRpc(piSettings, cwd, environment);
  },
  Effect.scoped,
  Effect.timeoutOption(PI_MODEL_DISCOVERY_TIMEOUT_MS),
  Effect.map(Option.getOrUndefined),
  Effect.catchCause((cause) =>
    Effect.logWarning("Pi model discovery failed", { cause }).pipe(Effect.as(undefined)),
  ),
);

export const discoverPiModelsViaRpc = Effect.fn("discoverPiModelsViaRpc")(function* (
  piSettings: PiSettings,
  cwd: string,
  environment: NodeJS.ProcessEnv,
) {
  const discovered = yield* discoverPiProviderContextViaRpc(piSettings, cwd, environment);
  return discovered?.models.map(piModelInfoToServerModel) ?? [];
});

const modelsFromSettings = (
  piSettings: PiSettings,
  discovered: ReadonlyArray<ServerProviderModel>,
): ReadonlyArray<ServerProviderModel> =>
  providerModelsFromSettings(discovered, piSettings.customModels ?? [], EMPTY_CAPABILITIES);

export const buildInitialPiProviderSnapshot = Effect.fn("buildInitialPiProviderSnapshot")(
  function* (piSettings: PiSettings) {
    const checkedAt = yield* nowIso;
    const models = modelsFromSettings(piSettings, []);

    if (!piSettings.enabled) {
      return buildServerProvider({
        presentation: PI_PRESENTATION,
        enabled: false,
        checkedAt,
        models,
        probe: {
          installed: false,
          version: null,
          status: "warning",
          auth: { status: "unknown" },
          message: "Pi is disabled in T3 Code settings.",
        },
      });
    }

    return buildServerProvider({
      presentation: PI_PRESENTATION,
      enabled: true,
      checkedAt,
      models,
      probe: {
        installed: true,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Checking Pi availability...",
      },
    });
  },
);

export const checkPiProviderStatus = Effect.fn("checkPiProviderStatus")(function* (
  piSettings: PiSettings,
  cwd: string,
  environment: NodeJS.ProcessEnv = process.env,
  commandInventory?: PiCommandInventory,
) {
  const checkedAt = yield* nowIso;
  const fallbackModels = modelsFromSettings(piSettings, []);

  if (!piSettings.enabled) {
    return buildServerProvider({
      presentation: PI_PRESENTATION,
      enabled: false,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Pi is disabled in T3 Code settings.",
      },
    });
  }

  const versionProbe = yield* runPiVersion(piSettings, environment).pipe(
    Effect.timeoutOption(DEFAULT_TIMEOUT_MS),
    Effect.result,
  );

  if (Result.isFailure(versionProbe)) {
    const error = versionProbe.failure;
    return buildServerProvider({
      presentation: PI_PRESENTATION,
      enabled: piSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: !isCommandMissingCause(error),
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: isCommandMissingCause(error)
          ? "The configured Pi/OMP CLI is not installed or not on PATH."
          : "Failed to execute the Pi/OMP CLI health check.",
      },
    });
  }

  if (Option.isNone(versionProbe.success)) {
    return buildServerProvider({
      presentation: PI_PRESENTATION,
      enabled: piSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: "Pi CLI is installed but timed out while running `pi --version`.",
      },
    });
  }

  const version = versionProbe.success.value;
  const versionOutput = `${version.stdout}\n${version.stderr}`;
  const parsedVersion = parseGenericCliVersion(versionOutput);

  if (version.code !== 0) {
    const detail = detailFromResult(version);
    return buildServerProvider({
      presentation: PI_PRESENTATION,
      enabled: piSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version: parsedVersion,
        status: "error",
        auth: { status: "unknown" },
        message: detail ?? "Pi CLI returned an error during health check.",
      },
    });
  }

  const isOmp = /(?:^|\s)omp(?:\/|\s)/iu.test(versionOutput);
  const minimumVersion = isOmp ? MINIMUM_OMP_VERSION : MINIMUM_PI_VERSION;
  if (!parsedVersion || compareSemverVersions(parsedVersion, minimumVersion) < 0) {
    const cliName = isOmp ? "OMP" : "Pi";
    return buildServerProvider({
      presentation: PI_PRESENTATION,
      enabled: piSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version: parsedVersion,
        status: "error",
        auth: { status: "unknown" },
        message: parsedVersion
          ? `${cliName} v${parsedVersion} is too old. Upgrade to v${minimumVersion} or newer.`
          : `Unable to determine the ${cliName} version. T3 Code requires v${minimumVersion} or newer.`,
      },
    });
  }

  const discovery: PiRpcDiscoveryResult | undefined = yield* discoverPiProviderContextViaRpc(
    piSettings,
    cwd,
    environment,
  );
  if (discovery === undefined) {
    return buildServerProvider({
      presentation: PI_PRESENTATION,
      enabled: piSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version: parsedVersion,
        status: "error",
        auth: { status: "unknown" },
        message:
          "Pi/OMP RPC model discovery failed before it returned an inventory. Retry the provider; if it persists, check the CLI RPC configuration.",
      },
    });
  }
  if (commandInventory !== undefined) {
    yield* commandInventory.replace(discovery.commands);
  }
  const discoveredModels = discovery?.models.map(piModelInfoToServerModel) ?? [];
  const models = modelsFromSettings(piSettings, discoveredModels);

  // no auth query in pi; get_available_models only lists once a key is configured in ~/.pi/agent
  const authenticated = discoveredModels.length > 0;

  return buildServerProvider({
    presentation: PI_PRESENTATION,
    enabled: piSettings.enabled,
    checkedAt,
    models,
    probe: {
      installed: true,
      version: parsedVersion,
      status: authenticated ? "ready" : "warning",
      auth: { status: authenticated ? "authenticated" : "unknown", type: "pi" },
      ...(authenticated
        ? {}
        : {
            message:
              "The Pi/OMP CLI is installed but no models are available. Configure a provider or API key in that CLI so models appear.",
          }),
    },
  });
});
