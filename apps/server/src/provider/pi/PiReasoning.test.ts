import { TurnId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { makePiReasoningLifecycle } from "./PiReasoning.ts";
import type { AgentSessionEvent } from "./PiRpcProtocol.ts";
import type { PiSessionEvent } from "./PiSessionEvents.ts";

function update(
  assistantMessageEvent:
    | { readonly type: "thinking_start" | "thinking_end"; readonly contentIndex: number }
    | { readonly type: "thinking_delta"; readonly contentIndex: number; readonly delta: string },
): AgentSessionEvent {
  return { type: "message_update", assistantMessageEvent };
}

describe("Pi reasoning lifecycle", () => {
  it.effect("uses one stable item per content index and synthesizes missing starts", () =>
    Effect.gen(function* () {
      const events: Array<PiSessionEvent> = [];
      const reasoning = makePiReasoningLifecycle({
        getTurn: () => ({ turnId: TurnId.make("turn-reasoning"), items: [] }),
        emit: (event) => Effect.sync(() => events.push(event)).pipe(Effect.asVoid),
      });
      yield* reasoning.handle(update({ type: "thinking_delta", contentIndex: 2, delta: "first" }));
      yield* reasoning.handle(
        update({ type: "thinking_delta", contentIndex: 2, delta: " second" }),
      );
      yield* reasoning.handle(update({ type: "thinking_start", contentIndex: 4 }));
      yield* reasoning.handle(update({ type: "thinking_delta", contentIndex: 4, delta: "other" }));
      yield* reasoning.handle(update({ type: "thinking_end", contentIndex: 2 }));
      yield* reasoning.completeOpen;

      expect(events.map((event) => event.type)).toEqual([
        "item.started",
        "content.delta",
        "content.delta",
        "item.started",
        "content.delta",
        "item.completed",
        "item.completed",
      ]);
      expect(events.slice(0, 3).map((event) => event.itemId)).toEqual([
        "turn-reasoning:reasoning:2",
        "turn-reasoning:reasoning:2",
        "turn-reasoning:reasoning:2",
      ]);
      expect(events[5]).toMatchObject({
        itemId: "turn-reasoning:reasoning:2",
        payload: { detail: "first second", data: { contentIndex: 2, text: "first second" } },
      });
      expect(events[6]).toMatchObject({ itemId: "turn-reasoning:reasoning:4" });
    }),
  );
});
