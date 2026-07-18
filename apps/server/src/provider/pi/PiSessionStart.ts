import type { PiSettings, ProviderSessionStartInput, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Scope from "effect/Scope";
import type * as PlatformError from "effect/PlatformError";
import { ChildProcessSpawner } from "effect/unstable/process";

import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  type ProviderAdapterError,
} from "../Errors.ts";
import { type PiThinkingLevel, type RpcCommand } from "./PiModels.ts";
import type { PiCommandInventory } from "./PiCommands.ts";
import {
  decodeSessionStateFor,
  piResponseSucceeded,
  type PiRpcDialectCodec,
} from "./PiRpcDialect.ts";
import { buildPiRpcLaunch, resolvePiApprovalLaunch } from "./PiRpcLaunch.ts";
import { makeOmpDialectCodec } from "./PiRpcOmpDialect.ts";
import { makePiDialectCodec } from "./PiRpcPiDialect.ts";
import {
  makePiRpcTransport,
  type MakePiRpcTransportOptions,
  type PiRpcTransport,
} from "./PiRpcTransport.ts";

const APPROVAL_SENTINEL = "t3-approval-gate";

export { resolvePiApprovalLaunch } from "./PiRpcLaunch.ts";

export interface StartPiSessionOptions {
  readonly input: ProviderSessionStartInput;
  readonly settings: PiSettings;
  readonly environment: NodeJS.ProcessEnv;
  readonly cwd: string;
  readonly model: string | undefined;
  readonly thinking: PiThinkingLevel | undefined;
  readonly approvalExtensionPath?: string;
  readonly commandInventory: PiCommandInventory;
  readonly scope: Scope.Closeable;
  readonly spawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly nextId: Effect.Effect<string>;
  readonly onExit: Effect.Effect<void>;
  readonly makeTransport?: (
    options: MakePiRpcTransportOptions,
  ) => Effect.Effect<
    PiRpcTransport,
    PlatformError.PlatformError,
    Scope.Scope | ChildProcessSpawner.ChildProcessSpawner
  >;
}

export const startPiSessionTransport = Effect.fn("startPiSessionTransport")(function* (
  options: StartPiSessionOptions,
): Effect.fn.Return<
  {
    readonly transport: PiRpcTransport;
    readonly sessionFile: string | undefined;
    readonly codec: PiRpcDialectCodec;
  },
  ProviderAdapterError
> {
  const threadId: ThreadId = options.input.threadId;
  const launch = buildPiRpcLaunch({
    settings: options.settings,
    environment: options.environment,
    extensionPaths: [],
    purpose: {
      kind: "session",
      runtimeMode: options.input.runtimeMode,
      ...(options.input.resumeCursor !== undefined
        ? { resumeCursor: options.input.resumeCursor }
        : {}),
      ...(options.model !== undefined ? { model: options.model } : {}),
      ...(options.thinking !== undefined ? { thinking: options.thinking } : {}),
      ...(options.approvalExtensionPath !== undefined
        ? { approvalExtensionPath: options.approvalExtensionPath }
        : {}),
    },
  });
  if (launch.kind !== "ok") {
    return yield* new ProviderAdapterProcessError({
      provider: "pi",
      threadId,
      detail: "Tool approval is required but the bundled Pi approval gate is unavailable.",
    });
  }
  const transport = yield* (options.makeTransport ?? makePiRpcTransport)({
    binaryPath: launch.launch.binaryPath,
    args: launch.launch.args,
    cwd: options.cwd,
    env: launch.launch.environment,
    onExit: options.onExit,
  }).pipe(
    Effect.provideService(Scope.Scope, options.scope),
    Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, options.spawner),
    Effect.mapError(
      (cause) =>
        new ProviderAdapterProcessError({
          provider: "pi",
          threadId,
          detail: "Failed to start Pi RPC process.",
          cause,
        }),
    ),
    Effect.onError(() => Scope.close(options.scope, Exit.void).pipe(Effect.ignore)),
  );
  return yield* Effect.gen(function* () {
    const request = (command: RpcCommand, timeout: number) =>
      Effect.gen(function* () {
        const id = yield* options.nextId;
        return yield* transport.request(command, id, timeout).pipe(
          Effect.mapError(
            (cause) =>
              new ProviderAdapterRequestError({
                provider: "pi",
                method: command.type,
                detail: cause.detail,
                cause,
              }),
          ),
        );
      });
    const sessionState = decodeSessionStateFor(yield* request({ type: "get_state" }, 5_000));
    const sessionFile = Option.getOrUndefined(sessionState)?.sessionFile;
    const availableCommands = yield* request({ type: "get_available_commands" }, 5_000);
    const codec = piResponseSucceeded(availableCommands, "get_available_commands")
      ? makeOmpDialectCodec()
      : makePiDialectCodec();
    const commandResponse =
      codec.kind === "omp" ? availableCommands : yield* request(codec.listCommandsCommand, 5_000);
    const commands = codec.decodeCommands(commandResponse);
    yield* options.commandInventory.replace(commands);
    if (
      resolvePiApprovalLaunch(launch.launch.binaryPath, options.input.runtimeMode).kind ===
      "pi-extension"
    ) {
      if (!commands.some((command) => command.name === APPROVAL_SENTINEL)) {
        yield* transport.kill;
        return yield* new ProviderAdapterProcessError({
          provider: "pi",
          threadId,
          detail: "Tool approval is enabled but the Pi approval gate failed to load.",
        });
      }
    }
    return { transport, sessionFile, codec };
  }).pipe(Effect.onError(() => Scope.close(options.scope, Exit.void).pipe(Effect.ignore)));
});
