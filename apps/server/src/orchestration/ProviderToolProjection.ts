import {
  EventId,
  isToolLifecycleItemType,
  type OrchestrationThreadActivity,
  type ProviderRuntimeEvent,
  type ToolLifecycleItemType,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

const UnknownRecord = Schema.Record(Schema.String, Schema.Unknown);
const ToolPayload = Schema.Struct({
  itemType: Schema.String,
  toolCallId: Schema.optional(Schema.String),
  title: Schema.optional(Schema.String),
  detail: Schema.optional(Schema.String),
  status: Schema.optional(Schema.String),
  data: Schema.optional(Schema.Unknown),
});
type DecodedToolPayload = typeof ToolPayload.Type;
const decodeUnknownRecord = Schema.decodeUnknownOption(UnknownRecord);
const decodeToolPayload = Schema.decodeUnknownOption(ToolPayload);

function record(value: unknown): Readonly<Record<string, unknown>> {
  return Option.getOrElse(decodeUnknownRecord(value), () => ({}));
}

function activityId(itemId: string): EventId {
  return EventId.make(`provider-tool:${itemId}`);
}

function toolType(
  event: ProviderRuntimeEvent,
  previous: DecodedToolPayload | undefined,
): ToolLifecycleItemType | undefined {
  if (
    (event.type === "item.started" ||
      event.type === "item.updated" ||
      event.type === "item.completed") &&
    isToolLifecycleItemType(event.payload.itemType)
  ) {
    return event.payload.itemType;
  }
  return previous !== undefined && isToolLifecycleItemType(previous.itemType)
    ? previous.itemType
    : undefined;
}

export function projectProviderToolActivity(
  event: ProviderRuntimeEvent,
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): OrchestrationThreadActivity | undefined {
  const itemId = event.itemId === undefined ? undefined : String(event.itemId);
  if (itemId === undefined) return undefined;
  const lifecycle =
    event.type === "item.started" ||
    event.type === "item.updated" ||
    event.type === "item.completed";
  const outputDelta =
    event.type === "content.delta" &&
    event.payload.streamKind !== "assistant_text" &&
    event.payload.streamKind !== "reasoning_text";
  if (!lifecycle && !outputDelta) return undefined;

  const id = activityId(itemId);
  const previousActivity = activities.find((activity) => activity.id === id);
  const previous = previousActivity
    ? Option.getOrUndefined(decodeToolPayload(previousActivity.payload))
    : undefined;
  const itemType = toolType(event, previous);
  if (itemType === undefined) return undefined;
  const eventData = lifecycle ? event.payload.data : undefined;
  const previousData = record(previous?.data);
  const nextData = { ...previousData, ...record(eventData) };
  const previousOutput = typeof previousData["output"] === "string" ? previousData["output"] : "";
  const data = outputDelta
    ? { ...nextData, output: `${previousOutput}${event.payload.delta}` }
    : nextData;
  const title = lifecycle ? (event.payload.title ?? previous?.title) : previous?.title;
  const detail = lifecycle ? (event.payload.detail ?? previous?.detail) : previous?.detail;
  const status =
    event.type === "item.completed"
      ? (event.payload.status ?? "completed")
      : event.type === "item.updated"
        ? (event.payload.status ?? previous?.status ?? "running")
        : (previous?.status ?? "running");
  return {
    id,
    tone: "tool",
    kind:
      event.type === "item.completed"
        ? "tool.completed"
        : outputDelta
          ? "tool.updated"
          : `tool.${event.type.slice(5)}`,
    summary: title ?? "Tool",
    payload: {
      itemType,
      toolCallId: itemId,
      ...(title !== undefined ? { title } : {}),
      ...(detail !== undefined ? { detail } : {}),
      status,
      data,
    },
    turnId: event.turnId ?? null,
    createdAt: previousActivity?.createdAt ?? event.createdAt,
  };
}
