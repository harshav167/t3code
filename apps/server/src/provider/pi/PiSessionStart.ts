import type { PiSettings, ProviderSessionStartInput, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Scope from "effect/Scope";
import type * as PlatformError from "effect/PlatformError";
import { ChildProcessSpawner } from "effect/unstable/process";

import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  type ProviderAdapterError,
} from "../Errors.ts";
import {
  extractSessionFile,
  piResponseHasCommand,
  piResponseSucceeded,
  type PiRpcDialect,
  type PiThinkingLevel,
  type RpcCommand,
} from "./PiModels.ts";
import {
  makePiRpcTransport,
  type MakePiRpcTransportOptions,
  type PiRpcTransport,
} from "./PiRpcTransport.ts";

const APPROVAL_SENTINEL = "t3-approval-gate";

export function resolvePiApprovalLaunch(
  binaryPath: string,
  runtimeMode: ProviderSessionStartInput["runtimeMode"],
):
  | { readonly kind: "none" }
  | { readonly kind: "pi-extension" }
  | { readonly kind: "omp-native"; readonly mode: "always-ask" | "write" } {
  if (runtimeMode === "full-access") return { kind: "none" };
  const executable = binaryPath.split(/[\\/]/u).at(-1)?.toLowerCase();
  if (
    executable === "omp" ||
    executable === "omp.exe" ||
    executable === "oh-my-pi" ||
    executable === "oh-my-pi.exe"
  ) {
    return {
      kind: "omp-native",
      mode: runtimeMode === "approval-required" ? "always-ask" : "write",
    };
  }
  return { kind: "pi-extension" };
}

export interface StartPiSessionOptions {
  readonly input: ProviderSessionStartInput;
  readonly settings: PiSettings;
  readonly environment: NodeJS.ProcessEnv;
  readonly cwd: string;
  readonly model: string | undefined;
  readonly thinking: PiThinkingLevel | undefined;
  readonly approvalExtensionPath?: string;
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
    readonly dialect: PiRpcDialect;
  },
  ProviderAdapterError
> {
  const threadId: ThreadId = options.input.threadId;
  const args = ["--mode", "rpc"];
  const resume = options.input.resumeCursor;
  if (
    resume &&
    typeof resume === "object" &&
    "sessionFile" in resume &&
    typeof resume.sessionFile === "string"
  ) {
    args.push("--session", resume.sessionFile);
  }
  if (options.model) args.push("--model", options.model);
  if (options.thinking) args.push("--thinking", options.thinking);
  const binaryPath = options.settings.binaryPath || "pi";
  const approvalLaunch = resolvePiApprovalLaunch(binaryPath, options.input.runtimeMode);
  if (approvalLaunch.kind === "pi-extension" && !options.approvalExtensionPath) {
    return yield* new ProviderAdapterProcessError({
      provider: "pi",
      threadId,
      detail: "Tool approval is required but the bundled Pi approval gate is unavailable.",
    });
  }
  let environment = options.environment;
  if (approvalLaunch.kind === "omp-native") {
    args.push("--approval-mode", approvalLaunch.mode);
  } else if (approvalLaunch.kind === "pi-extension" && options.approvalExtensionPath) {
    args.push("--extension", options.approvalExtensionPath);
    environment = { ...environment, T3_PI_APPROVAL_MODE: options.input.runtimeMode };
  }
  const transport = yield* (options.makeTransport ?? makePiRpcTransport)({
    binaryPath,
    args,
    cwd: options.cwd,
    env: environment,
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
    const sessionFile = extractSessionFile(yield* request({ type: "get_state" }, 5_000));
    const availableCommands = yield* request({ type: "get_available_commands" }, 5_000);
    const dialect: PiRpcDialect = piResponseSucceeded(availableCommands, "get_available_commands")
      ? "omp"
      : "pi";
    if (approvalLaunch.kind === "pi-extension") {
      const commands =
        dialect === "omp" ? availableCommands : yield* request({ type: "get_commands" }, 5_000);
      if (!piResponseHasCommand(commands, APPROVAL_SENTINEL)) {
        yield* transport.kill;
        return yield* new ProviderAdapterProcessError({
          provider: "pi",
          threadId,
          detail: "Tool approval is enabled but the Pi approval gate failed to load.",
        });
      }
    }
    return { transport, sessionFile, dialect };
  }).pipe(Effect.onError(() => Scope.close(options.scope, Exit.void).pipe(Effect.ignore)));
});
