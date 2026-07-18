import { describe, expect, it } from "@effect/vitest";
import {
  EventId,
  ProviderDriverKind,
  RuntimeItemId,
  ThreadId,
  TurnId,
  type ProviderRuntimeEvent,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { projectProviderReasoningActivity } from "./ProviderReasoningProjection.ts";
import { projectProviderToolActivity } from "./ProviderToolProjection.ts";

const UnknownRecord = Schema.Record(Schema.String, Schema.Unknown);
const decodeUnknownRecord = Schema.decodeUnknownOption(UnknownRecord);
const provider = ProviderDriverKind.make("pi");
const threadId = ThreadId.make("thread-projection");
const turnId = TurnId.make("turn-projection");
const createdAt = "2026-07-18T00:00:00.000Z";

function event(value: ProviderRuntimeEvent): ProviderRuntimeEvent {
  return value;
}

function payload(value: unknown): Readonly<Record<string, unknown>> {
  return Option.getOrThrow(decodeUnknownRecord(value));
}

describe("provider item projection", () => {
  it("synthesizes reasoning start, keeps stable identity, and restores accumulated text", () => {
    const itemId = RuntimeItemId.make("reasoning-2");
    const first = projectProviderReasoningActivity(
      event({
        type: "content.delta",
        eventId: EventId.make("event-reasoning-1"),
        provider,
        threadId,
        turnId,
        itemId,
        createdAt,
        payload: { streamKind: "reasoning_text", delta: "Inspect ", contentIndex: 2 },
      }),
      [],
    );
    expect(first?.id).toBe("provider-reasoning:reasoning-2");
    expect(first?.tone).toBe("thinking");

    const restored = first === undefined ? [] : [{ ...first }];
    const second = projectProviderReasoningActivity(
      event({
        type: "content.delta",
        eventId: EventId.make("event-reasoning-2"),
        provider,
        threadId,
        turnId,
        itemId,
        createdAt,
        payload: { streamKind: "reasoning_text", delta: "the adapter", contentIndex: 2 },
      }),
      restored,
    );
    expect(second?.id).toBe(first?.id);
    expect(payload(second?.payload)["detail"]).toBe("Inspect the adapter");

    const completed = projectProviderReasoningActivity(
      event({
        type: "item.completed",
        eventId: EventId.make("event-reasoning-3"),
        provider,
        threadId,
        turnId,
        itemId,
        createdAt,
        payload: {
          itemType: "reasoning",
          status: "completed",
          title: "Thinking",
          detail: "Inspect the adapter",
        },
      }),
      second === undefined ? [] : [second],
    );
    expect(completed?.id).toBe(first?.id);
    expect(completed?.kind).toBe("reasoning.completed");
    expect(payload(completed?.payload)["status"]).toBe("completed");
  });

  it("merges structured tool input, streamed output, images, errors, and completion", () => {
    const itemId = RuntimeItemId.make("tool-read-1");
    const started = projectProviderToolActivity(
      event({
        type: "item.started",
        eventId: EventId.make("event-tool-1"),
        provider,
        threadId,
        turnId,
        itemId,
        createdAt,
        payload: {
          itemType: "dynamic_tool_call",
          title: "/repo/src/app.ts",
          detail: "read",
          data: { toolName: "read", input: { path: "/repo/src/app.ts" } },
        },
      }),
      [],
    );
    const updated = projectProviderToolActivity(
      event({
        type: "content.delta",
        eventId: EventId.make("event-tool-2"),
        provider,
        threadId,
        turnId,
        itemId,
        createdAt,
        payload: { streamKind: "unknown", delta: "partial output" },
      }),
      started === undefined ? [] : [started],
    );
    const result = {
      content: [
        { type: "text", text: "partial output" },
        { type: "image", data: "aW1hZ2U=", mimeType: "image/png" },
      ],
      metadata: { path: "/repo/src/app.ts" },
    };
    const completed = projectProviderToolActivity(
      event({
        type: "item.completed",
        eventId: EventId.make("event-tool-3"),
        provider,
        threadId,
        turnId,
        itemId,
        createdAt,
        payload: {
          itemType: "dynamic_tool_call",
          status: "failed",
          title: "/repo/src/app.ts",
          detail: "read",
          data: { result, error: "read failed" },
        },
      }),
      updated === undefined ? [] : [updated],
    );
    const completedPayload = payload(completed?.payload);
    const data = payload(completedPayload["data"]);
    expect(completed?.id).toBe("provider-tool:tool-read-1");
    expect(completed?.kind).toBe("tool.completed");
    expect(completedPayload["status"]).toBe("failed");
    expect(data["output"]).toBe("partial output");
    expect(data["result"]).toEqual(result);
    expect(data["error"]).toBe("read failed");
  });

  it("leaves legacy item events without item IDs to the ingestion fallback", () => {
    expect(
      projectProviderToolActivity(
        event({
          type: "item.started",
          eventId: EventId.make("legacy-event"),
          provider,
          threadId,
          turnId,
          createdAt,
          payload: { itemType: "command_execution", title: "Run" },
        }),
        [],
      ),
    ).toBeUndefined();
  });
});
