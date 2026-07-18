import { RuntimeItemId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import type { AgentSessionEvent } from "./PiRpcProtocol.ts";
import type { PiSessionEvent } from "./PiSessionEvents.ts";
import type { PiTurnState } from "./PiSessionTypes.ts";

export function handlePiCompactionEvent(
  options: {
    readonly getTurn: () => PiTurnState | undefined;
    readonly emit: (event: PiSessionEvent) => Effect.Effect<void>;
    readonly refreshUsage: (turn: PiTurnState) => Effect.Effect<void>;
  },
  event: AgentSessionEvent,
): Effect.Effect<boolean> {
  return Effect.gen(function* () {
    if (event.type !== "compaction_start" && event.type !== "compaction_end") return false;
    const turn = options.getTurn();
    if (turn === undefined) return true;
    const itemId = RuntimeItemId.make(`${turn.turnId}:compaction`);
    if (event.type === "compaction_start") {
      yield* options.emit({
        type: "item.started",
        turnId: turn.turnId,
        itemId,
        payload: {
          itemType: "context_compaction",
          title: "Compacting context",
          detail: typeof event.reason === "string" ? event.reason : "Context limit reached",
          status: "inProgress",
        },
      });
      return true;
    }
    const aborted = event.aborted === true;
    yield* options.emit({
      type: "item.completed",
      turnId: turn.turnId,
      itemId,
      payload: {
        itemType: "context_compaction",
        title: aborted ? "Context compaction stopped" : "Context compacted",
        status: aborted ? "failed" : "completed",
        data: event,
      },
    });
    if (!aborted) yield* options.refreshUsage(turn);
    return true;
  });
}
