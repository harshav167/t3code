import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import type { PiCommandInventory } from "./PiCommands.ts";
import type { PiRpcDialectCodec } from "./PiRpcDialect.ts";
import type { PiControlFrame } from "./PiRpcProtocol.ts";
import type { PiSessionEvent } from "./PiSessionEvents.ts";
import type { PiTurnState } from "./PiSessionTypes.ts";
import { handlePiOmpControl } from "./PiOmpControl.ts";
import type { PiThinkingLevel } from "./PiRpcTypes.ts";

export function handlePiControlFrame(
  options: {
    readonly getTurn: () => PiTurnState | undefined;
    readonly getCodec: () => PiRpcDialectCodec;
    readonly commandInventory: PiCommandInventory;
    readonly emit: (event: PiSessionEvent) => Effect.Effect<void>;
    readonly settlePending: Effect.Effect<void>;
    readonly completeTurn: (
      state: "completed" | "failed",
      errorMessage?: string,
    ) => Effect.Effect<void>;
    readonly applyConfig: (
      model: string | undefined,
      thinking: PiThinkingLevel | undefined,
    ) => Effect.Effect<void>;
    readonly refreshUsage: (turn: PiTurnState) => Effect.Effect<void>;
  },
  frame: PiControlFrame,
): Effect.Effect<void> {
  return Effect.gen(function* () {
    if (frame.type === "available_commands_update") {
      const commands = options.getCodec().decodeCommandUpdate(frame);
      if (Option.isSome(commands)) yield* options.commandInventory.replace(commands.value);
      return;
    }
    if (yield* handlePiOmpControl(options, frame)) return;
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
        if (frame.id !== undefined && frame.id !== turn.promptRequestId) return;
        if (!frame.agentInvoked) {
          yield* options.settlePending;
          yield* options.completeTurn("completed");
        }
        return;
      case "ready":
      case "subagent_event":
      case "session_info_update":
      case "retry_fallback_applied":
      case "retry_fallback_succeeded":
      case "ttsr_triggered":
      case "todo_reminder":
      case "todo_auto_clear":
      case "irc_message":
      case "goal_updated":
        return;
    }
  });
}
