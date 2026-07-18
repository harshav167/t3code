import {
  EventId,
  type OrchestrationThreadActivity,
  type ProviderRuntimeEvent,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

const ReasoningPayload = Schema.Struct({
  itemType: Schema.Literal("reasoning"),
  itemId: Schema.optional(Schema.String),
  detail: Schema.optional(Schema.String),
  status: Schema.optional(Schema.String),
});
const decodeReasoningPayload = Schema.decodeUnknownOption(ReasoningPayload);

function reasoningKey(event: ProviderRuntimeEvent): string | undefined {
  if (event.itemId !== undefined) return String(event.itemId);
  if (event.type !== "content.delta" || event.payload.streamKind !== "reasoning_text") {
    return undefined;
  }
  const index = event.payload.contentIndex ?? event.payload.summaryIndex;
  return index === undefined
    ? `reasoning:${event.threadId}:${event.turnId ?? event.eventId}`
    : `reasoning:${event.threadId}:${event.turnId ?? "session"}:${index}`;
}

function activityId(key: string): EventId {
  return EventId.make(`provider-reasoning:${key}`);
}

export function projectProviderReasoningActivity(
  event: ProviderRuntimeEvent,
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): OrchestrationThreadActivity | undefined {
  const isStart = event.type === "item.started" && event.payload.itemType === "reasoning";
  const isDelta = event.type === "content.delta" && event.payload.streamKind === "reasoning_text";
  const isCompletion = event.type === "item.completed" && event.payload.itemType === "reasoning";
  if (!isStart && !isDelta && !isCompletion) return undefined;

  const key = reasoningKey(event);
  if (key === undefined) return undefined;
  const id = activityId(key);
  const previous = activities.find((activity) => activity.id === id);
  const previousPayload = previous
    ? Option.getOrUndefined(decodeReasoningPayload(previous.payload))
    : undefined;
  const previousText = previousPayload?.detail ?? "";
  const text = isDelta
    ? `${previousText}${event.payload.delta}`
    : isCompletion && event.payload.detail !== undefined
      ? event.payload.detail
      : previousText;
  const status = isCompletion ? (event.payload.status ?? "completed") : "running";
  return {
    id,
    tone: "thinking",
    kind: isCompletion
      ? "reasoning.completed"
      : isDelta
        ? "reasoning.updated"
        : "reasoning.started",
    summary: "Thinking",
    payload: {
      itemType: "reasoning",
      itemId: key,
      ...(text.length > 0 ? { detail: text } : {}),
      status,
    },
    turnId: event.turnId ?? null,
    createdAt: previous?.createdAt ?? event.createdAt,
  };
}
