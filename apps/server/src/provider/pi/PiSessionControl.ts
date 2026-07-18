import * as Effect from "effect/Effect";

import type { PiControlFrame } from "./PiRpcProtocol.ts";
import type { PiSessionEvent } from "./PiSessionEvents.ts";
import type { PiTurnState } from "./PiSessionTypes.ts";

export function handlePiControlFrame(
  options: {
    readonly getTurn: () => PiTurnState | undefined;
    readonly emit: (event: PiSessionEvent) => Effect.Effect<void>;
    readonly settlePending: Effect.Effect<void>;
    readonly completeTurn: (
      state: "completed" | "failed",
      errorMessage?: string,
    ) => Effect.Effect<void>;
  },
  frame: PiControlFrame,
): Effect.Effect<void> {
  return Effect.gen(function* () {
    const turn = options.getTurn();
    if (!turn) return;
    switch (frame.type) {
      case "command_output":
        if (frame.text) {
          yield* options.emit({
            type: "content.delta",
            turnId: turn.turnId,
            payload: { streamKind: "command_output", delta: frame.text },
            raw: { source: "pi.rpc.control", method: frame.type, payload: frame },
          });
        }
        return;
      case "prompt_result":
        if (frame.id !== turn.promptRequestId) return;
        if (!frame.agentInvoked) {
          yield* options.settlePending;
          yield* options.completeTurn("completed");
        }
        return;
      case "ready":
      case "available_commands_update":
      case "subagent_lifecycle":
      case "subagent_progress":
      case "subagent_event":
      case "session_info_update":
      case "config_update":
      case "auto_compaction_start":
      case "auto_compaction_end":
      case "retry_fallback_applied":
      case "retry_fallback_succeeded":
      case "ttsr_triggered":
      case "todo_reminder":
      case "todo_auto_clear":
      case "irc_message":
      case "notice":
      case "goal_updated":
        return;
    }
  });
}
