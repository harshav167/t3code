import {
  ApprovalRequestId,
  type ProviderRuntimeEvent,
  RuntimeItemId,
  RuntimeRequestId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import type { ProviderAdapterRequestError } from "../Errors.ts";
import { piContentDelta } from "./PiContent.ts";
import { handlePiControlFrame } from "./PiSessionControl.ts";
import { buildPiUserInputQuestion, type PendingUserInput } from "./PiExtensionUi.ts";
import type {
  AgentSessionEvent,
  PiStdoutMessage,
  RpcExtensionUIRequest,
  RpcExtensionUIResponse,
} from "./PiRpcProtocol.ts";
import { piAgentEndOutcome } from "./PiSessionLifecycle.ts";
import type { PiPendingApproval, PiTurnState } from "./PiSessionTypes.ts";
import {
  classifyPiApprovalRequestType,
  classifyPiToolItemType,
  piToolOutputStreamKind,
  piToolResultText,
  summarizePiToolArgs,
} from "./PiTools.ts";
export type PiSessionEvent = Omit<
  ProviderRuntimeEvent,
  "eventId" | "createdAt" | "provider" | "providerInstanceId" | "threadId"
>;

export interface MakePiSessionMessageHandlerOptions {
  readonly nextRequestId: Effect.Effect<ApprovalRequestId>;
  readonly getTurn: () => PiTurnState | undefined;
  readonly pendingApprovals: Map<ApprovalRequestId, PiPendingApproval>;
  readonly pendingInputs: Map<ApprovalRequestId, PendingUserInput>;
  readonly sessionApprovals: Set<string>;
  readonly writeExtension: (
    response: RpcExtensionUIResponse,
  ) => Effect.Effect<void, ProviderAdapterRequestError>;
  readonly emit: (event: PiSessionEvent) => Effect.Effect<void>;
  readonly settlePending: Effect.Effect<void>;
  readonly completeTurn: (
    state: "completed" | "failed",
    errorMessage?: string,
  ) => Effect.Effect<void>;
}

export function makePiSessionMessageHandler(options: MakePiSessionMessageHandlerOptions) {
  const handleExtension = (request: RpcExtensionUIRequest) =>
    Effect.gen(function* () {
      if (request.method === "cancel") {
        const approval = [...options.pendingApprovals].find(
          ([, pending]) => pending.piId === request.targetId,
        );
        if (approval) {
          const [requestId] = approval;
          options.pendingApprovals.delete(requestId);
          const turn = options.getTurn();
          yield* options.emit({
            type: "request.resolved",
            ...(turn ? { turnId: turn.turnId } : {}),
            requestId: RuntimeRequestId.make(requestId),
            payload: { requestType: approval[1].requestType, decision: "cancel" },
          });
          return;
        }
        const input = [...options.pendingInputs].find(
          ([, pending]) => pending.piId === request.targetId,
        );
        if (input) {
          const [requestId] = input;
          options.pendingInputs.delete(requestId);
          const turn = options.getTurn();
          yield* options.emit({
            type: "user-input.resolved",
            ...(turn ? { turnId: turn.turnId } : {}),
            requestId: RuntimeRequestId.make(requestId),
            payload: { answers: {} },
          });
        }
        return;
      }
      if (
        request.method !== "confirm" &&
        request.method !== "select" &&
        request.method !== "input" &&
        request.method !== "editor"
      ) {
        return;
      }
      const requestId = yield* options.nextRequestId;
      const turn = options.getTurn();
      if (request.method === "confirm") {
        const requestType = classifyPiApprovalRequestType(request.title);
        const detail = request.message ? `${request.title}\n${request.message}` : request.title;
        const sessionApprovalKey = `${requestType}:${detail}`;
        if (options.sessionApprovals.has(sessionApprovalKey)) {
          const delivered = yield* options
            .writeExtension({ type: "extension_ui_response", id: request.id, confirmed: true })
            .pipe(
              Effect.as(true),
              Effect.orElseSucceed(() => false),
            );
          if (delivered) return;
        }
        options.pendingApprovals.set(requestId, {
          piId: request.id,
          requestType,
          sessionApprovalKey,
        });
        yield* options.emit({
          type: "request.opened",
          ...(turn ? { turnId: turn.turnId } : {}),
          requestId: RuntimeRequestId.make(requestId),
          payload: { requestType, detail: detail.slice(0, 2_000), args: request },
          raw: { source: "pi.rpc.extension-ui", method: request.method, payload: request },
        });
        return;
      }
      const questionId = String(requestId);
      const projected = buildPiUserInputQuestion({
        questionId,
        method: request.method,
        title: request.title,
        ...(request.method === "select" ? { options: request.options } : {}),
      });
      options.pendingInputs.set(requestId, {
        piId: request.id,
        questionId,
        method: request.method,
        ...(projected.numberedOptions ? { numberedOptions: projected.numberedOptions } : {}),
      });
      yield* options.emit({
        type: "user-input.requested",
        ...(turn ? { turnId: turn.turnId } : {}),
        requestId: RuntimeRequestId.make(requestId),
        payload: { questions: [projected.question] },
        raw: { source: "pi.rpc.extension-ui", method: request.method, payload: request },
      });
    });

  const handleEvent = (event: AgentSessionEvent) =>
    Effect.gen(function* () {
      const turn = options.getTurn();
      const raw = { raw: { source: "pi.rpc.event", method: event.type, payload: event } } as const;
      if (event.type === "message_update" && turn) {
        const content = piContentDelta(event);
        if (content) {
          yield* options.emit({
            type: "content.delta",
            turnId: turn.turnId,
            payload: content,
            ...raw,
          });
        }
        return;
      }
      if (event.type === "tool_execution_start" && turn) {
        const itemId = RuntimeItemId.make(event.toolCallId);
        const itemType = classifyPiToolItemType(event.toolName);
        turn.items.push({ id: itemId, type: itemType, toolName: event.toolName, args: event.args });
        const detail = summarizePiToolArgs(event.args);
        yield* options.emit({
          type: "item.started",
          turnId: turn.turnId,
          itemId,
          payload: { itemType, title: event.toolName, ...(detail ? { detail } : {}) },
          ...raw,
        });
        return;
      }
      if (event.type === "tool_execution_update" && turn) {
        const itemId = RuntimeItemId.make(event.toolCallId);
        const item = turn.items.find(({ id }) => id === itemId);
        const output = piToolResultText(event.partialResult);
        const delta =
          item?.output && output.startsWith(item.output)
            ? output.slice(item.output.length)
            : output;
        if (item) item.output = output;
        if (delta) {
          yield* options.emit({
            type: "content.delta",
            turnId: turn.turnId,
            itemId,
            payload: { streamKind: piToolOutputStreamKind(event.toolName), delta },
            ...raw,
          });
        }
        return;
      }
      if (event.type === "tool_execution_end" && turn) {
        const itemId = RuntimeItemId.make(event.toolCallId);
        const item = turn.items.find(({ id }) => id === itemId);
        const output = piToolResultText(event.result);
        const delta =
          item?.output && output.startsWith(item.output)
            ? output.slice(item.output.length)
            : output;
        if (delta) {
          yield* options.emit({
            type: "content.delta",
            turnId: turn.turnId,
            itemId,
            payload: { streamKind: piToolOutputStreamKind(event.toolName), delta },
            ...raw,
          });
        }
        if (item) {
          item.output = output;
          item.result = event.result;
          item.status = event.isError ? "failed" : "completed";
        }
        const detail = summarizePiToolArgs(item?.args);
        yield* options.emit({
          type: "item.completed",
          turnId: turn.turnId,
          itemId,
          payload: {
            itemType: classifyPiToolItemType(event.toolName),
            title: event.toolName,
            status: event.isError ? "failed" : "completed",
            ...(detail ? { detail } : {}),
          },
          ...raw,
        });
        return;
      }
      const outcome = piAgentEndOutcome(event);
      if (outcome) {
        yield* options.settlePending;
        yield* options.completeTurn(outcome.state, outcome.errorMessage);
      }
    });

  return (message: PiStdoutMessage): Effect.Effect<void> => {
    switch (message._tag) {
      case "event":
        return handleEvent(message.event);
      case "extension-ui":
        return handleExtension(message.request);
      case "control":
        return handlePiControlFrame(options, message.frame);
      case "response":
        return Effect.void;
    }
  };
}
