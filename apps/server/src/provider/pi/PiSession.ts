import {
  ApprovalRequestId,
  EventId,
  ProviderDriverKind,
  type ProviderRuntimeEvent,
  type ProviderSession,
  TurnId,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/unstable/process";

import { ServerConfig } from "../../config.ts";
import { ProviderAdapterSessionClosedError } from "../Errors.ts";
import type { PendingUserInput } from "./PiExtensionUi.ts";
import { type PiRpcDialect, resolvePiThinkingLevel } from "./PiModels.ts";
import { makePiSessionMessageHandler, type PiSessionEvent } from "./PiSessionEvents.ts";
import { makePiSessionLifecycle } from "./PiSessionLifecycle.ts";
import { makePiSessionOperations } from "./PiSessionOperations.ts";
import { startPiSessionTransport } from "./PiSessionStart.ts";
import type {
  MakePiSessionOptions,
  PiPendingApproval,
  PiSessionModule,
  PiTurnState,
} from "./PiSessionTypes.ts";
import { makePiSessionTransportOps } from "./PiSessionTransportOps.ts";
import type { PiRpcTransport } from "./PiRpcTransport.ts";
import { type PiToolItem } from "./PiTools.ts";

const PROVIDER = ProviderDriverKind.make("pi");

export const makePiSession = Effect.fn("makePiSession")(function* (options: MakePiSessionOptions) {
  const crypto = yield* Crypto.Crypto;
  const fs = yield* FileSystem.FileSystem;
  const serverConfig = yield* ServerConfig;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const lock = yield* Semaphore.make(1);
  const scope = yield* Scope.make();
  const nextUuid = crypto.randomUUIDv4.pipe(Effect.orDie);
  const now = Effect.map(DateTime.now, DateTime.formatIso);
  const threadId = options.input.threadId;
  const modelSelection =
    options.input.modelSelection?.instanceId === options.instanceId
      ? options.input.modelSelection
      : undefined;
  let session: ProviderSession = {
    threadId,
    provider: PROVIDER,
    providerInstanceId: options.instanceId,
    status: "ready",
    runtimeMode: options.input.runtimeMode,
    ...(options.input.cwd ? { cwd: options.input.cwd } : {}),
    ...(modelSelection?.model ? { model: modelSelection.model } : {}),
    createdAt: yield* now,
    updatedAt: yield* now,
  };
  let transport: PiRpcTransport | undefined;
  let notificationFiber: Fiber.Fiber<void, never> | undefined;
  let stopped = false;
  let turn: PiTurnState | undefined;
  let currentModel = modelSelection?.model;
  let appliedThinking = resolvePiThinkingLevel(modelSelection);
  let dialect: PiRpcDialect = "pi";
  const turns: Array<{ id: TurnId; items: Array<PiToolItem> }> = [];
  const pendingApprovals = new Map<ApprovalRequestId, PiPendingApproval>();
  const pendingInputs = new Map<ApprovalRequestId, PendingUserInput>();
  const sessionApprovals = new Set<string>();

  const stamp = () =>
    Effect.all({ eventId: nextUuid.pipe(Effect.map(EventId.make)), createdAt: now });
  const emit = (event: PiSessionEvent) =>
    stamp().pipe(
      Effect.flatMap((value) =>
        options.emit({
          ...event,
          ...value,
          provider: PROVIDER,
          providerInstanceId: options.instanceId,
          threadId,
        } as ProviderRuntimeEvent),
      ),
    );
  const failClosed = () =>
    stopped
      ? Effect.fail(new ProviderAdapterSessionClosedError({ provider: PROVIDER, threadId }))
      : Effect.void;

  const { request, writeExtension } = makePiSessionTransportOps({
    provider: PROVIDER,
    nextUuid,
    getTransport: () => transport!,
  });

  const { completeTurn, settlePending, stopInternal } = makePiSessionLifecycle({
    threadId,
    scope,
    now,
    getSession: () => session,
    setSession: (value) => {
      session = value;
    },
    getTurn: () => turn,
    setTurn: (value) => {
      turn = value;
    },
    turns,
    pendingApprovals,
    pendingInputs,
    getNotificationFiber: () => notificationFiber,
    getStopped: () => stopped,
    setStopped: () => {
      stopped = true;
    },
    writeExtension,
    emit,
    onStopped: options.onStopped(threadId),
  });

  const handleMessage = makePiSessionMessageHandler({
    nextRequestId: nextUuid.pipe(Effect.map(ApprovalRequestId.make)),
    getTurn: () => turn,
    pendingApprovals,
    pendingInputs,
    sessionApprovals,
    writeExtension,
    emit,
    settlePending,
    completeTurn,
  });

  const start = lock.withPermits(1)(
    Effect.gen(function* () {
      const started = yield* startPiSessionTransport({
        input: options.input,
        settings: options.settings,
        environment: options.environment,
        cwd: options.input.cwd ?? serverConfig.cwd,
        model: modelSelection?.model,
        thinking: appliedThinking,
        ...(options.approvalExtensionPath
          ? { approvalExtensionPath: options.approvalExtensionPath }
          : {}),
        scope,
        spawner,
        nextId: nextUuid,
        onExit: lock.withPermits(1)(stopInternal(true)),
        ...(options.makeTransport ? { makeTransport: options.makeTransport } : {}),
      });
      transport = started.transport;
      dialect = started.dialect;
      notificationFiber = yield* Stream.fromQueue(transport.messages).pipe(
        Stream.runForEach((message) => lock.withPermits(1)(handleMessage(message))),
        Effect.catchCause((cause) =>
          Effect.logError("Failed to process Pi runtime message.", { cause }),
        ),
        Effect.forkIn(scope),
      );
      const sessionFile = started.sessionFile;
      if (sessionFile) session = { ...session, resumeCursor: { sessionFile } };
      yield* emit({ type: "session.started", payload: {} });
      if (sessionFile)
        yield* emit({ type: "thread.started", payload: { providerThreadId: sessionFile } });
      yield* emit({
        type: "session.configured",
        payload: {
          config: {
            ...(modelSelection?.model ? { model: modelSelection.model } : {}),
            ...(options.input.cwd ? { cwd: options.input.cwd } : {}),
          },
        },
      });
      yield* emit({ type: "session.state.changed", payload: { state: "ready" } });
      return { ...session };
    }),
  );

  const operations = makePiSessionOperations({
    threadId,
    instanceId: options.instanceId,
    attachmentsDir: serverConfig.attachmentsDir,
    fileSystem: fs,
    nextUuid,
    now,
    serialize: (effect) => lock.withPermits(1)(effect),
    getSession: () => session,
    setSession: (value) => {
      session = value;
    },
    getTurn: () => turn,
    setTurn: (value) => {
      turn = value;
    },
    getCurrentModel: () => currentModel,
    setCurrentModel: (value) => {
      currentModel = value;
    },
    getThinking: () => appliedThinking,
    setThinking: (value) => {
      appliedThinking = value;
    },
    getDialect: () => dialect,
    turns,
    pendingApprovals,
    pendingInputs,
    sessionApprovals,
    request,
    writeExtension,
    emit,
    failClosed,
    settlePending,
    completeTurn,
    stopUnexpected: stopInternal(true),
  });

  return {
    start,
    ...operations,
    stop: lock.withPermits(1)(stopInternal(false)),
    hasStopped: Effect.sync(() => stopped),
    readSession: Effect.sync(() => ({ ...session })),
  } satisfies PiSessionModule;
});
