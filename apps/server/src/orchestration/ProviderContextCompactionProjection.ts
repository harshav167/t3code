import {
  EventId,
  type OrchestrationThreadActivity,
  type ProviderRuntimeEvent,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

const CompactionPayload = Schema.Struct({
  itemType: Schema.Literal("context_compaction"),
  title: Schema.optional(Schema.String),
  detail: Schema.optional(Schema.String),
  status: Schema.optional(Schema.String),
  data: Schema.optional(Schema.Unknown),
});
const decodeCompactionPayload = Schema.decodeUnknownOption(CompactionPayload);

export function projectProviderContextCompactionActivity(
  event: ProviderRuntimeEvent,
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): OrchestrationThreadActivity | undefined {
  if (
    (event.type !== "item.started" &&
      event.type !== "item.updated" &&
      event.type !== "item.completed") ||
    event.payload.itemType !== "context_compaction" ||
    event.itemId === undefined
  ) {
    return undefined;
  }
  const id = EventId.make(`provider-compaction:${event.itemId}`);
  const previousActivity = activities.find((activity) => activity.id === id);
  const previous = previousActivity
    ? Option.getOrUndefined(decodeCompactionPayload(previousActivity.payload))
    : undefined;
  const completed = event.type === "item.completed";
  const title = event.payload.title ?? previous?.title ?? "Context compaction";
  return {
    id,
    tone: completed && event.payload.status === "failed" ? "error" : "info",
    kind: completed ? "context-compaction.completed" : "context-compaction.started",
    summary: title,
    payload: {
      itemType: "context_compaction",
      title,
      ...(event.payload.detail !== undefined
        ? { detail: event.payload.detail }
        : previous?.detail !== undefined
          ? { detail: previous.detail }
          : {}),
      status: event.payload.status ?? previous?.status ?? "inProgress",
      data: event.payload.data ?? previous?.data,
    },
    turnId: event.turnId ?? null,
    createdAt: previousActivity?.createdAt ?? event.createdAt,
  };
}
