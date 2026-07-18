import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { resolveSpawnCommand } from "@t3tools/shared/shell";
import type { RpcCommand } from "./PiModels.ts";
import {
  decodePiStdoutLine,
  type PiStdoutMessage,
  type RpcExtensionUIRequest,
  type RpcExtensionUIResponse,
  type RpcResponse,
} from "./PiRpcProtocol.ts";

const encodeJsonString = Schema.encodeSync(Schema.UnknownFromJsonString);

export class PiRpcTransportError extends Schema.TaggedErrorClass<PiRpcTransportError>()(
  "PiRpcTransportError",
  {
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export interface PiRpcTransport {
  readonly writeCommand: (command: RpcCommand) => Effect.Effect<void, PiRpcTransportError>;
  readonly writeExtensionResponse: (
    response: RpcExtensionUIResponse,
  ) => Effect.Effect<void, PiRpcTransportError>;
  readonly request: (
    command: RpcCommand,
    id: string,
    timeoutMs: number,
  ) => Effect.Effect<RpcResponse | undefined, PiRpcTransportError>;
  readonly messages: Queue.Dequeue<PiStdoutMessage>;
  readonly kill: Effect.Effect<void>;
}

export interface MakePiRpcTransportOptions {
  readonly binaryPath: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly onExit: Effect.Effect<void>;
}

export const makePiRpcTransport = (options: MakePiRpcTransportOptions) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const spawnCommand = yield* resolveSpawnCommand(options.binaryPath || "pi", options.args, {
      env: options.env,
      extendEnv: true,
    });
    const child = yield* spawner.spawn(
      ChildProcess.make(spawnCommand.command, spawnCommand.args, {
        cwd: options.cwd,
        env: options.env,
        extendEnv: true,
        shell: spawnCommand.shell,
        forceKillAfter: 5000,
      }),
    );

    const outgoing = yield* Queue.unbounded<Uint8Array>();
    const messages = yield* Queue.unbounded<PiStdoutMessage>();
    const pending = new Map<string, Deferred.Deferred<RpcResponse, PiRpcTransportError>>();
    let terminalError: PiRpcTransportError | undefined;

    const failPending = (error: PiRpcTransportError) =>
      Effect.forEach(pending, ([, deferred]) => Deferred.fail(deferred, error), {
        discard: true,
      }).pipe(
        Effect.andThen(
          Effect.sync(() => {
            pending.clear();
          }),
        ),
      );

    const close = (error: PiRpcTransportError): Effect.Effect<void> =>
      Effect.suspend(() => {
        if (terminalError) return Effect.void;
        terminalError = error;
        return failPending(error).pipe(
          Effect.andThen(Queue.shutdown(messages)),
          Effect.andThen(Queue.shutdown(outgoing)),
          Effect.andThen(options.onExit),
          Effect.ignore,
        );
      });

    const writeLine = (
      value: RpcCommand | RpcExtensionUIResponse,
    ): Effect.Effect<void, PiRpcTransportError> =>
      Effect.suspend(() =>
        terminalError
          ? Effect.fail(terminalError)
          : Queue.offer(outgoing, Buffer.from(`${encodeJsonString(value)}\n`)).pipe(
              Effect.asVoid,
              Effect.mapError(
                (cause) => new PiRpcTransportError({ detail: "Pi RPC stdin is closed.", cause }),
              ),
            ),
      );

    const cancelInvalidExtensionRequest = (request: { readonly id: RpcExtensionUIRequest["id"] }) =>
      writeLine({ type: "extension_ui_response", id: request.id, cancelled: true }).pipe(
        Effect.catch(() => Effect.void),
      );

    const handleLine = (line: string): Effect.Effect<void> =>
      Effect.gen(function* () {
        const decoded = decodePiStdoutLine(line);
        switch (decoded._tag) {
          case "Ignored":
            return;
          case "Message": {
            const message = decoded.message;
            if (message._tag !== "response") {
              yield* Queue.offer(messages, message);
              return;
            }
            const deferred = pending.get(message.id);
            if (deferred) {
              pending.delete(message.id);
              yield* Deferred.succeed(deferred, message.response);
            }
            return;
          }
          case "InvalidResponse": {
            const deferred = pending.get(decoded.id);
            if (deferred) {
              pending.delete(decoded.id);
              yield* Deferred.fail(
                deferred,
                new PiRpcTransportError({
                  detail: `Invalid Pi response '${decoded.id}': ${decoded.error}`,
                }),
              );
            }
            return;
          }
          case "InvalidExtensionUiRequest":
            yield* cancelInvalidExtensionRequest(decoded);
            return;
          case "FatalProtocolError": {
            const error = new PiRpcTransportError({
              detail: `Fatal Pi RPC protocol error: ${decoded.error}`,
            });
            yield* close(error);
            yield* child.kill().pipe(Effect.ignore);
          }
        }
      });

    const exited = new PiRpcTransportError({ detail: "Pi RPC process exited." });
    yield* Stream.fromQueue(outgoing).pipe(
      Stream.run(child.stdin),
      Effect.catchCause((cause) =>
        close(new PiRpcTransportError({ detail: "Pi RPC stdin failed.", cause })),
      ),
      Effect.forkScoped,
    );
    yield* child.stderr.pipe(Stream.runDrain, Effect.ignore, Effect.forkScoped);
    yield* child.stdout.pipe(
      Stream.decodeText(),
      Stream.splitLines,
      Stream.runForEach(handleLine),
      Effect.catchCause((cause) =>
        close(new PiRpcTransportError({ detail: "Pi RPC stdout failed.", cause })),
      ),
      Effect.ensuring(close(exited)),
      Effect.forkScoped,
    );

    const request: PiRpcTransport["request"] = (command, id, timeoutMs) =>
      Effect.suspend(() => {
        if (terminalError) return Effect.fail(terminalError);
        return Effect.gen(function* () {
          const deferred = yield* Deferred.make<RpcResponse, PiRpcTransportError>();
          const registered = yield* Effect.sync(() => {
            if (pending.has(id)) return false;
            pending.set(id, deferred);
            return true;
          });
          if (!registered) {
            return yield* new PiRpcTransportError({
              detail: `Duplicate Pi RPC request id: ${id}.`,
            });
          }
          return yield* Effect.gen(function* () {
            yield* writeLine({ ...command, id });
            return Option.getOrUndefined(
              yield* Deferred.await(deferred).pipe(Effect.timeoutOption(timeoutMs)),
            );
          }).pipe(
            Effect.ensuring(
              Effect.sync(() => {
                pending.delete(id);
              }),
            ),
          );
        });
      });

    return {
      writeCommand: writeLine,
      writeExtensionResponse: writeLine,
      request,
      messages,
      kill: child.kill().pipe(Effect.ignore),
    } satisfies PiRpcTransport;
  });
