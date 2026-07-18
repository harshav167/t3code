import { RuntimeItemId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import type { AgentSessionEvent } from "./PiRpcProtocol.ts";
import type { PiSessionEvent } from "./PiSessionEvents.ts";
import type { PiTurnState } from "./PiSessionTypes.ts";

interface OpenReasoning {
  readonly itemId: RuntimeItemId;
  text: string;
}

export function makePiReasoningLifecycle(options: {
  readonly getTurn: () => PiTurnState | undefined;
  readonly emit: (event: PiSessionEvent) => Effect.Effect<void>;
}) {
  const openByIndex = new Map<number, OpenReasoning>();

  const start = (contentIndex: number) =>
    Effect.gen(function* () {
      const turn = options.getTurn();
      if (turn === undefined) return undefined;
      const existing = openByIndex.get(contentIndex);
      if (existing !== undefined) return existing;
      const itemId = RuntimeItemId.make(`${turn.turnId}:reasoning:${contentIndex}`);
      const reasoning = { itemId, text: "" };
      openByIndex.set(contentIndex, reasoning);
      yield* options.emit({
        type: "item.started",
        turnId: turn.turnId,
        itemId,
        payload: {
          itemType: "reasoning",
          title: "Thinking",
          data: { contentIndex },
        },
      });
      return reasoning;
    });

  const completeIndex = (contentIndex: number) =>
    Effect.gen(function* () {
      const turn = options.getTurn();
      const reasoning = openByIndex.get(contentIndex);
      if (turn === undefined || reasoning === undefined) return;
      openByIndex.delete(contentIndex);
      yield* options.emit({
        type: "item.completed",
        turnId: turn.turnId,
        itemId: reasoning.itemId,
        payload: {
          itemType: "reasoning",
          title: "Thinking",
          status: "completed",
          ...(reasoning.text.length > 0 ? { detail: reasoning.text } : {}),
          data: { contentIndex, text: reasoning.text },
        },
      });
    });

  const handle = (event: AgentSessionEvent) =>
    Effect.gen(function* () {
      if (event.type !== "message_update") return false;
      const update = event.assistantMessageEvent;
      if (update.type === "thinking_start") {
        yield* start(update.contentIndex);
        return true;
      }
      if (update.type === "thinking_delta") {
        const turn = options.getTurn();
        const reasoning = yield* start(update.contentIndex);
        if (turn === undefined || reasoning === undefined) return true;
        reasoning.text += update.delta;
        yield* options.emit({
          type: "content.delta",
          turnId: turn.turnId,
          itemId: reasoning.itemId,
          payload: {
            streamKind: "reasoning_text",
            delta: update.delta,
            contentIndex: update.contentIndex,
          },
        });
        return true;
      }
      if (update.type === "thinking_end") {
        yield* completeIndex(update.contentIndex);
        return true;
      }
      return false;
    });

  const completeOpen = Effect.suspend(() =>
    Effect.forEach([...openByIndex.keys()], completeIndex, { discard: true }),
  );
  const clear = Effect.sync(() => openByIndex.clear());
  return { handle, completeOpen, clear };
}
