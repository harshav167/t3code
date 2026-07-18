import type { ApprovalRequestId, ProviderSession, ThreadId, TurnId } from "@t3tools/contracts";
import { RuntimeRequestId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Scope from "effect/Scope";

import type { ProviderAdapterRequestError } from "../Errors.ts";
import type { PendingUserInput } from "./PiExtensionUi.ts";
import type { PiSessionEvent } from "./PiSessionEvents.ts";
import type { AgentSessionEvent, RpcExtensionUIResponse } from "./PiRpcProtocol.ts";
import type { PiPendingApproval, PiTurnState } from "./PiSessionTypes.ts";
import type { PiToolItem } from "./PiTools.ts";

export function piAgentEndOutcome(
  event: AgentSessionEvent,
): { readonly state: "completed" | "failed"; readonly errorMessage?: string } | null {
  if (event.type !== "agent_end" || event.willRetry === true) return null;
  const assistant = [...event.messages]
    .toReversed()
    .find(
      (message): message is Record<string, unknown> =>
        message !== null &&
        typeof message === "object" &&
        "role" in message &&
        message.role === "assistant",
    );
  if (assistant?.["stopReason"] !== "error") return { state: "completed" };
  const errorMessage = assistant["errorMessage"];
  return {
    state: "failed",
    ...(typeof errorMessage === "string" && errorMessage.trim()
      ? { errorMessage: errorMessage.trim() }
      : {}),
  };
}

export interface PiSessionLifecycleOptions {
  readonly threadId: ThreadId;
  readonly scope: Scope.Closeable;
  readonly now: Effect.Effect<string>;
  readonly getSession: () => ProviderSession;
  readonly setSession: (session: ProviderSession) => void;
  readonly getTurn: () => PiTurnState | undefined;
  readonly setTurn: (turn: PiTurnState | undefined) => void;
  readonly turns: Array<{ id: TurnId; items: Array<PiToolItem> }>;
  readonly pendingApprovals: Map<ApprovalRequestId, PiPendingApproval>;
  readonly pendingInputs: Map<ApprovalRequestId, PendingUserInput>;
  readonly getNotificationFiber: () => Fiber.Fiber<void, never> | undefined;
  readonly getStopped: () => boolean;
  readonly setStopped: () => void;
  readonly writeExtension: (
    response: RpcExtensionUIResponse,
  ) => Effect.Effect<void, ProviderAdapterRequestError>;
  readonly emit: (event: PiSessionEvent) => Effect.Effect<void>;
  readonly onStopped: Effect.Effect<void>;
}

export function makePiSessionLifecycle(options: PiSessionLifecycleOptions) {
  const completeTurn = (state: "completed" | "failed" | "interrupted", errorMessage?: string) =>
    Effect.gen(function* () {
      const active = options.getTurn();
      if (!active) return;
      options.setTurn(undefined);
      options.turns.push({ id: active.turnId, items: [...active.items] });
      const { activeTurnId: _, ...ready } = options.getSession();
      options.setSession({ ...ready, status: "ready", updatedAt: yield* options.now });
      yield* options.emit({
        type: "turn.completed",
        turnId: active.turnId,
        payload: { state, ...(errorMessage ? { errorMessage } : {}) },
      });
    });

  const settlePending = Effect.gen(function* () {
    const approvals = [...options.pendingApprovals];
    const inputs = [...options.pendingInputs];
    options.pendingApprovals.clear();
    options.pendingInputs.clear();
    for (const [requestId, pending] of approvals) {
      yield* options
        .writeExtension({ type: "extension_ui_response", id: pending.piId, cancelled: true })
        .pipe(Effect.ignore);
      const turn = options.getTurn();
      yield* options.emit({
        type: "request.resolved",
        ...(turn ? { turnId: turn.turnId } : {}),
        requestId: RuntimeRequestId.make(requestId),
        payload: { requestType: pending.requestType, decision: "cancel" },
      });
    }
    for (const [requestId, pending] of inputs) {
      yield* options
        .writeExtension({ type: "extension_ui_response", id: pending.piId, cancelled: true })
        .pipe(Effect.ignore);
      const turn = options.getTurn();
      yield* options.emit({
        type: "user-input.resolved",
        ...(turn ? { turnId: turn.turnId } : {}),
        requestId: RuntimeRequestId.make(requestId),
        payload: { answers: {} },
      });
    }
  });

  const stopInternal = (unexpected: boolean, emitExit = true) =>
    Effect.gen(function* () {
      if (options.getStopped()) return;
      options.setStopped();
      yield* settlePending;
      if (options.getTurn()) {
        yield* completeTurn("interrupted", unexpected ? "Pi process exited." : "Session stopped.");
      }
      const fiber = options.getNotificationFiber();
      if (fiber) yield* Fiber.interrupt(fiber);
      yield* Scope.close(options.scope, Exit.void).pipe(Effect.ignore);
      const { activeTurnId: _, ...closed } = options.getSession();
      options.setSession({ ...closed, status: "closed", updatedAt: yield* options.now });
      yield* options.onStopped;
      if (emitExit) {
        yield* options.emit({
          type: "session.exited",
          payload: {
            reason: unexpected ? "Pi process exited unexpectedly." : "Session stopped",
            exitKind: unexpected ? "error" : "graceful",
            ...(unexpected ? { recoverable: false } : {}),
          },
        });
      }
    });

  return { completeTurn, settlePending, stopInternal } as const;
}
