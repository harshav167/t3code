import {
  ApprovalRequestId,
  type ProviderApprovalDecision,
  type ProviderInstanceId,
  type ProviderSession,
  type ProviderUserInputAnswers,
  RuntimeRequestId,
  type ThreadId,
  TurnId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";

import {
  ProviderAdapterRequestError,
  ProviderAdapterValidationError,
  type ProviderAdapterError,
} from "../Errors.ts";
import {
  buildPiApprovalResponse,
  buildPiUserInputResponse,
  type PendingUserInput,
} from "./PiExtensionUi.ts";
import { resolveForkTargetEntryId, type PiThinkingLevel, type RpcCommand } from "./PiModels.ts";
import {
  piResponseSucceeded,
  piRollbackSucceeded,
  type PiRpcDialectCodec,
} from "./PiRpcDialect.ts";
import type { PiSessionEvent } from "./PiSessionEvents.ts";
import type { RpcExtensionUIResponse, RpcResponse } from "./PiRpcProtocol.ts";
import type { PiPendingApproval, PiTurnState } from "./PiSessionTypes.ts";
import { makePiSessionTurnOperations } from "./PiSessionTurnOperations.ts";
import type { PiToolItem } from "./PiTools.ts";

const PROVIDER = "pi" as const;

export interface PiSessionOperationsOptions {
  readonly threadId: ThreadId;
  readonly instanceId: ProviderInstanceId;
  readonly attachmentsDir: string;
  readonly fileSystem: FileSystem.FileSystem;
  readonly nextUuid: Effect.Effect<string>;
  readonly now: Effect.Effect<string>;
  readonly serialize: <A, E>(effect: Effect.Effect<A, E>) => Effect.Effect<A, E>;
  readonly getSession: () => ProviderSession;
  readonly setSession: (session: ProviderSession) => void;
  readonly getTurn: () => PiTurnState | undefined;
  readonly setTurn: (turn: PiTurnState | undefined) => void;
  readonly getCurrentModel: () => string | undefined;
  readonly setCurrentModel: (model: string | undefined) => void;
  readonly getThinking: () => PiThinkingLevel | undefined;
  readonly setThinking: (thinking: PiThinkingLevel | undefined) => void;
  readonly getCodec: () => PiRpcDialectCodec;
  readonly turns: Array<{ id: TurnId; items: Array<PiToolItem> }>;
  readonly pendingApprovals: Map<ApprovalRequestId, PiPendingApproval>;
  readonly pendingInputs: Map<ApprovalRequestId, PendingUserInput>;
  readonly sessionApprovals: Set<string>;
  readonly request: (
    command: RpcCommand,
    timeout: number,
    requestId?: string,
  ) => Effect.Effect<RpcResponse | undefined, ProviderAdapterRequestError>;
  readonly writeExtension: (
    response: RpcExtensionUIResponse,
  ) => Effect.Effect<void, ProviderAdapterRequestError>;
  readonly emit: (event: PiSessionEvent) => Effect.Effect<void>;
  readonly failClosed: () => Effect.Effect<void, ProviderAdapterError>;
  readonly settlePending: Effect.Effect<void>;
  readonly completeTurn: (
    state: "completed" | "failed" | "interrupted",
    errorMessage?: string,
  ) => Effect.Effect<void>;
  readonly stopUnexpected: Effect.Effect<void>;
}

export function makePiSessionOperations(options: PiSessionOperationsOptions) {
  const { sendTurn } = makePiSessionTurnOperations(options);

  const readThread = options.serialize(
    Effect.gen(function* () {
      yield* options.failClosed();
      return {
        threadId: options.threadId,
        turns: options.turns.map(({ id, items }) => ({ id, items: [...items] })),
      };
    }),
  );

  const rollbackThread = (numTurns: number) =>
    options.serialize(
      Effect.gen(function* () {
        yield* options.failClosed();
        if (!Number.isInteger(numTurns) || numTurns < 1) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "rollbackThread",
            issue: "numTurns must be an integer >= 1.",
          });
        }
        if (options.getTurn()) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "rollbackThread",
            issue: "Cannot roll back while a Pi turn is running.",
          });
        }
        const codec = options.getCodec();
        const messages = yield* options.request(codec.listRollbackMessagesCommand, 5_000);
        if (!piResponseSucceeded(messages, codec.listRollbackMessagesCommand.type)) {
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: codec.listRollbackMessagesCommand.type,
            detail: "The Pi runtime did not return branchable messages for rollback.",
          });
        }
        const target = resolveForkTargetEntryId(codec.decodeRollbackMessages(messages), numTurns);
        if (!target) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "rollbackThread",
            issue: "Pi has no exact native rollback target for the requested turns.",
          });
        }
        const replacement = yield* options.request(
          target.kind === "fork"
            ? codec.makeRollbackCommand(target.entryId)
            : { type: "new_session" },
          15_000,
        );
        if (!piRollbackSucceeded(replacement)) {
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method:
              target.kind === "fork"
                ? codec.makeRollbackCommand(target.entryId).type
                : "new_session",
            detail: "Pi rejected or cancelled the rollback.",
          });
        }
        yield* options.settlePending;
        options.sessionApprovals.clear();
        options.turns.splice(Math.max(0, options.turns.length - numTurns));
        const snapshot = {
          threadId: options.threadId,
          turns: options.turns.map(({ id, items }) => ({ id, items: [...items] })),
        };
        const state = yield* options
          .request({ type: "get_state" }, 5_000)
          .pipe(Effect.orElseSucceed(() => undefined));
        const sessionFile = Option.getOrUndefined(codec.decodeSessionState(state))?.sessionFile;
        if (sessionFile) {
          options.setSession({
            ...options.getSession(),
            resumeCursor: { sessionFile },
            updatedAt: yield* options.now,
          });
          yield* options.emit({
            type: "thread.started",
            payload: { providerThreadId: sessionFile },
          });
        } else {
          options.setSession({ ...options.getSession(), resumeCursor: undefined });
          yield* options.stopUnexpected;
        }
        return snapshot;
      }),
    );

  return {
    sendTurn,
    readThread,
    rollbackThread,
    interruptTurn: options.serialize(
      Effect.gen(function* () {
        yield* options.failClosed();
        const response = yield* options.request({ type: "abort" }, 5_000);
        if (!piResponseSucceeded(response, "abort")) {
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "abort",
            detail: "The Pi runtime did not accept the interrupt.",
          });
        }
        yield* options.settlePending;
        yield* options.completeTurn("interrupted", "Turn interrupted.");
      }),
    ),
    respondToRequest: (requestId: ApprovalRequestId, decision: ProviderApprovalDecision) =>
      options.serialize(
        Effect.gen(function* () {
          yield* options.failClosed();
          const pending = options.pendingApprovals.get(requestId);
          if (!pending) {
            return yield* new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "respondToRequest",
              detail: `Unknown pending approval request: ${requestId}.`,
            });
          }
          yield* options.writeExtension(buildPiApprovalResponse(pending.piId, decision));
          options.pendingApprovals.delete(requestId);
          if (decision === "acceptForSession") {
            options.sessionApprovals.add(pending.sessionApprovalKey);
          }
          const turn = options.getTurn();
          yield* options.emit({
            type: "request.resolved",
            ...(turn ? { turnId: turn.turnId } : {}),
            requestId: RuntimeRequestId.make(requestId),
            payload: { requestType: pending.requestType, decision },
          });
        }),
      ),
    respondToUserInput: (requestId: ApprovalRequestId, answers: ProviderUserInputAnswers) =>
      options.serialize(
        Effect.gen(function* () {
          yield* options.failClosed();
          const pending = options.pendingInputs.get(requestId);
          if (!pending) {
            return yield* new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "respondToUserInput",
              detail: `Unknown pending user-input request: ${requestId}.`,
            });
          }
          yield* options.writeExtension(buildPiUserInputResponse(pending, answers));
          options.pendingInputs.delete(requestId);
          const turn = options.getTurn();
          yield* options.emit({
            type: "user-input.resolved",
            ...(turn ? { turnId: turn.turnId } : {}),
            requestId: RuntimeRequestId.make(requestId),
            payload: { answers },
          });
        }),
      ),
  };
}
