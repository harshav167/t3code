import { ApprovalRequestId, type ProviderRuntimeEvent, RuntimeItemId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import type { ProviderAdapterRequestError } from "../Errors.ts";
import type { PiCommandInventory } from "./PiCommands.ts";
import { handlePiCompactionEvent } from "./PiCompaction.ts";
import { piContentDelta } from "./PiContent.ts";
import { handlePiControlFrame } from "./PiSessionControl.ts";
import type { PendingUserInput } from "./PiExtensionUi.ts";
import { handlePiExtensionUiRequest } from "./PiExtensionUiEvents.ts";
import type {
  AgentSessionEvent,
  PiStdoutMessage,
  RpcExtensionUIResponse,
} from "./PiRpcProtocol.ts";
import type { PiRpcDialectCodec } from "./PiRpcDialect.ts";
import { piAgentEndOutcome } from "./PiSessionLifecycle.ts";
import { makePiReasoningLifecycle } from "./PiReasoning.ts";
import type { PiPendingApproval, PiTurnState } from "./PiSessionTypes.ts";
import {
  classifyPiToolItemType,
  piToolOutputStreamKind,
  piToolError,
  piToolResultText,
  piToolTitle,
  summarizePiToolArgs,
} from "./PiTools.ts";
export type PiSessionEvent = Omit<
  ProviderRuntimeEvent,
  "eventId" | "createdAt" | "provider" | "providerInstanceId" | "threadId"
>;

export interface MakePiSessionMessageHandlerOptions {
  readonly nextRequestId: Effect.Effect<ApprovalRequestId>;
  readonly getTurn: () => PiTurnState | undefined;
  readonly getCodec: () => PiRpcDialectCodec;
  readonly commandInventory: PiCommandInventory;
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
  readonly refreshUsage: (turn: PiTurnState) => Effect.Effect<void>;
  readonly applyConfig: (
    model: string | undefined,
    thinking: import("./PiRpcTypes.ts").PiThinkingLevel | undefined,
  ) => Effect.Effect<void>;
}

export function makePiSessionMessageHandler(options: MakePiSessionMessageHandlerOptions) {
  const reasoning = makePiReasoningLifecycle(options);

  const handleEvent = (event: AgentSessionEvent) =>
    Effect.gen(function* () {
      if (yield* handlePiCompactionEvent(options, event)) return;
      const turn = options.getTurn();
      const raw = { raw: { source: "pi.rpc.event", method: event.type, payload: event } } as const;
      if (event.type === "message_update" && turn) {
        if (yield* reasoning.handle(event)) return;
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
        const detail = summarizePiToolArgs(event.args, event.toolName);
        yield* options.emit({
          type: "item.started",
          turnId: turn.turnId,
          itemId,
          payload: {
            itemType,
            title: piToolTitle(event.toolName, event.args),
            ...(detail !== undefined ? { detail } : {}),
            data: { toolName: event.toolName, input: event.args },
          },
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
        const detail = summarizePiToolArgs(item?.args, event.toolName);
        const error = event.isError ? piToolError(event.result) : undefined;
        yield* options.emit({
          type: "item.completed",
          turnId: turn.turnId,
          itemId,
          payload: {
            itemType: classifyPiToolItemType(event.toolName),
            title: piToolTitle(event.toolName, item?.args),
            status: event.isError ? "failed" : "completed",
            ...(detail !== undefined ? { detail } : {}),
            data: {
              toolName: event.toolName,
              input: item?.args,
              output,
              result: event.result,
              ...(error !== undefined ? { error } : {}),
            },
          },
          ...raw,
        });
        return;
      }
      const outcome = piAgentEndOutcome(event);
      if (outcome) {
        yield* reasoning.completeOpen;
        if (outcome.state === "completed" && turn) yield* options.refreshUsage(turn);
        yield* options.settlePending;
        yield* options.completeTurn(outcome.state, outcome.errorMessage);
      }
    });

  const handle = (message: PiStdoutMessage): Effect.Effect<void> => {
    switch (message._tag) {
      case "event":
        return handleEvent(message.event);
      case "extension-ui":
        return handlePiExtensionUiRequest(options, message.request);
      case "control":
        return handlePiControlFrame(options, message.frame);
      case "response":
        return Effect.void;
    }
  };
  return { handle, completeReasoning: reasoning.completeOpen, clearReasoning: reasoning.clear };
}
