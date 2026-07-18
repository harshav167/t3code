import type { PiSettings } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import type { PiContextCommand, PiDiscoveredModel, PiRpcDialectCodec } from "./PiRpcDialect.ts";
import { decodeAvailableModels, piResponseSucceeded } from "./PiRpcDialect.ts";
import { buildPiRpcLaunch } from "./PiRpcLaunch.ts";
import { makeOmpDialectCodec } from "./PiRpcOmpDialect.ts";
import { makePiDialectCodec } from "./PiRpcPiDialect.ts";
import { makePiRpcTransport } from "./PiRpcTransport.ts";

export interface PiRpcDiscoveryResult {
  readonly codec: PiRpcDialectCodec;
  readonly models: ReadonlyArray<PiDiscoveredModel>;
  readonly commands: ReadonlyArray<PiContextCommand>;
}

const REQUEST_TIMEOUT_MS = 5_000;

export const discoverPiRpc = Effect.fn("discoverPiRpc")(function* (
  settings: PiSettings,
  cwd: string,
  environment: NodeJS.ProcessEnv,
) {
  const launch = buildPiRpcLaunch({
    settings,
    environment,
    extensionPaths: [],
    purpose: { kind: "discovery" },
  });
  if (launch.kind !== "ok") return yield* Effect.die("Invalid Pi discovery launch");
  const transport = yield* makePiRpcTransport({
    binaryPath: launch.launch.binaryPath,
    args: launch.launch.args,
    cwd,
    env: launch.launch.environment,
    onExit: Effect.void,
  });
  const modelsResponse = yield* transport.request(
    { type: "get_available_models" },
    "pi-model-discovery",
    REQUEST_TIMEOUT_MS,
  );
  const ompCommands = yield* Effect.option(
    transport.request(
      { type: "get_available_commands" },
      "pi-discovery-omp-commands",
      REQUEST_TIMEOUT_MS,
    ),
  );
  const codec = Option.match(ompCommands, {
    onNone: makePiDialectCodec,
    onSome: (response) =>
      piResponseSucceeded(response, "get_available_commands")
        ? makeOmpDialectCodec()
        : makePiDialectCodec(),
  });
  const commandsResponse =
    codec.kind === "omp"
      ? Option.getOrUndefined(ompCommands)
      : Option.getOrUndefined(
          yield* Effect.option(
            transport.request(
              codec.listCommandsCommand,
              "pi-discovery-pi-commands",
              REQUEST_TIMEOUT_MS,
            ),
          ),
        );
  return {
    codec,
    models: decodeAvailableModels(codec, modelsResponse),
    commands: codec.decodeCommands(commandsResponse),
  };
});
