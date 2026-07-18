import * as NodeURL from "node:url";

import {
  type PiSettings,
  ProviderInstanceId,
  ProviderDriverKind,
  type ProviderRuntimeEvent,
  type ThreadId,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import type * as PlatformError from "effect/PlatformError";
import { ChildProcessSpawner } from "effect/unstable/process";
import type { EventNdjsonLogger } from "./EventNdjsonLogger.ts";

import { ServerConfig } from "../../config.ts";
import { ProviderAdapterSessionNotFoundError, ProviderAdapterValidationError } from "../Errors.ts";
import type { PiAdapterShape } from "../Services/PiAdapter.ts";
import { makePiSession } from "../pi/PiSession.ts";
import type { PiSessionModule } from "../pi/PiSessionTypes.ts";
import type { MakePiRpcTransportOptions, PiRpcTransport } from "../pi/PiRpcTransport.ts";
import { makePiCommandInventory, type PiCommandInventory } from "../pi/PiCommands.ts";

const PROVIDER = ProviderDriverKind.make("pi");

const APPROVAL_EXTENSION_CANDIDATES = [
  "../assets/pi/t3-approvals.ts",
  "./assets/pi/t3-approvals.ts",
].flatMap((relative) => {
  try {
    return [NodeURL.fileURLToPath(new URL(relative, import.meta.url))];
  } catch {
    return [];
  }
});

export interface PiAdapterLiveOptions {
  readonly instanceId?: ProviderInstanceId;
  readonly environment?: NodeJS.ProcessEnv;
  readonly commandInventory?: PiCommandInventory;
  readonly nativeEventLogger?: EventNdjsonLogger;
  readonly makeTransport?: (
    options: MakePiRpcTransportOptions,
  ) => Effect.Effect<
    PiRpcTransport,
    PlatformError.PlatformError,
    Scope.Scope | ChildProcessSpawner.ChildProcessSpawner
  >;
}

export const makePiAdapter = Effect.fn("makePiAdapter")(function* (
  settings: PiSettings,
  options?: PiAdapterLiveOptions,
) {
  const instanceId = options?.instanceId ?? ProviderInstanceId.make("pi");
  const crypto = yield* Crypto.Crypto;
  const fs = yield* FileSystem.FileSystem;
  const serverConfig = yield* ServerConfig;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const sessions = new Map<ThreadId, PiSessionModule>();
  const transitions = yield* Semaphore.make(1);
  const runtimeEvents = yield* Queue.unbounded<ProviderRuntimeEvent>();
  const commandInventory = options?.commandInventory ?? (yield* makePiCommandInventory());

  let approvalExtensionPath: string | undefined;
  for (const candidate of APPROVAL_EXTENSION_CANDIDATES) {
    if (yield* fs.exists(candidate).pipe(Effect.orElseSucceed(() => false))) {
      approvalExtensionPath = candidate;
      break;
    }
  }

  const requireSession = (
    threadId: ThreadId,
  ): Effect.Effect<PiSessionModule, ProviderAdapterSessionNotFoundError> => {
    const session = sessions.get(threadId);
    return session
      ? Effect.succeed(session)
      : Effect.fail(new ProviderAdapterSessionNotFoundError({ provider: PROVIDER, threadId }));
  };

  const startSession: PiAdapterShape["startSession"] = (input) =>
    transitions.withPermits(1)(
      Effect.gen(function* () {
        if (input.provider !== undefined && input.provider !== PROVIDER) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "startSession",
            issue: `Expected provider '${PROVIDER}' but received '${input.provider}'.`,
          });
        }
        const existing = sessions.get(input.threadId);
        if (existing) yield* existing.stop.pipe(Effect.catchCause(() => Effect.void));

        let ownedSession: PiSessionModule | undefined;
        const session = yield* makePiSession({
          input,
          settings,
          instanceId,
          environment: options?.environment ?? process.env,
          commandInventory,
          ...(options?.nativeEventLogger ? { nativeEventLogger: options.nativeEventLogger } : {}),
          ...(approvalExtensionPath ? { approvalExtensionPath } : {}),
          ...(options?.makeTransport ? { makeTransport: options.makeTransport } : {}),
          emit: (event) => Queue.offer(runtimeEvents, event).pipe(Effect.asVoid),
          onStopped: (threadId) =>
            Effect.sync(() => {
              if (sessions.get(threadId) === ownedSession) sessions.delete(threadId);
            }),
        }).pipe(
          Effect.provideService(Crypto.Crypto, crypto),
          Effect.provideService(FileSystem.FileSystem, fs),
          Effect.provideService(ServerConfig, serverConfig),
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        );
        ownedSession = session;
        const started = yield* session.start;
        sessions.set(input.threadId, session);
        return started;
      }),
    );

  const sendTurn: PiAdapterShape["sendTurn"] = (input) =>
    requireSession(input.threadId).pipe(Effect.flatMap((session) => session.sendTurn(input)));
  const interruptTurn: PiAdapterShape["interruptTurn"] = (threadId) =>
    requireSession(threadId).pipe(Effect.flatMap((session) => session.interruptTurn));
  const respondToRequest: PiAdapterShape["respondToRequest"] = (threadId, requestId, decision) =>
    requireSession(threadId).pipe(
      Effect.flatMap((session) => session.respondToRequest(requestId, decision)),
    );
  const respondToUserInput: PiAdapterShape["respondToUserInput"] = (threadId, requestId, answers) =>
    requireSession(threadId).pipe(
      Effect.flatMap((session) => session.respondToUserInput(requestId, answers)),
    );
  const readThread: PiAdapterShape["readThread"] = (threadId) =>
    requireSession(threadId).pipe(Effect.flatMap((session) => session.readThread));
  const rollbackThread: PiAdapterShape["rollbackThread"] = (threadId, numTurns) =>
    requireSession(threadId).pipe(Effect.flatMap((session) => session.rollbackThread(numTurns)));
  const stopSession: PiAdapterShape["stopSession"] = (threadId) =>
    requireSession(threadId).pipe(Effect.flatMap((session) => session.stop));
  const listSessions: PiAdapterShape["listSessions"] = () =>
    Effect.forEach(sessions.values(), (session) => session.readSession);
  const hasSession: PiAdapterShape["hasSession"] = (threadId) =>
    Effect.suspend(() => {
      const session = sessions.get(threadId);
      return session
        ? session.hasStopped.pipe(Effect.map((value) => !value))
        : Effect.succeed(false);
    });
  const stopAll: PiAdapterShape["stopAll"] = () =>
    Effect.forEach([...sessions.values()], (session) => session.stop, { discard: true });

  yield* Effect.addFinalizer(() =>
    stopAll().pipe(
      Effect.catchCause(() => Effect.void),
      Effect.andThen(Queue.shutdown(runtimeEvents)),
    ),
  );

  return {
    provider: PROVIDER,
    capabilities: { sessionModelSwitch: "in-session", threadRollback: "provider-native" },
    startSession,
    sendTurn,
    interruptTurn,
    respondToRequest,
    respondToUserInput,
    readThread,
    rollbackThread,
    stopSession,
    listSessions,
    hasSession,
    stopAll,
    streamEvents: Stream.fromQueue(runtimeEvents),
  } satisfies PiAdapterShape;
});
