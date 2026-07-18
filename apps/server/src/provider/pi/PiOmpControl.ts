import { RuntimeItemId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { asPiThinkingLevel } from "./PiRpcDialect.ts";
import type { PiControlFrame } from "./PiRpcProtocol.ts";
import type { PiThinkingLevel } from "./PiRpcTypes.ts";
import type { PiSessionEvent } from "./PiSessionEvents.ts";
import type { PiTurnState } from "./PiSessionTypes.ts";

const OmpModel = Schema.Struct({ provider: Schema.String, id: Schema.String });
const SubagentLifecycle = Schema.Struct({
  id: Schema.String,
  agent: Schema.String,
  description: Schema.optional(Schema.String),
  status: Schema.Literals(["started", "completed", "failed", "aborted"]),
  sessionFile: Schema.optional(Schema.String),
  parentToolCallId: Schema.optional(Schema.String),
  index: Schema.Number,
});
const AgentProgress = Schema.Struct({
  id: Schema.String,
  status: Schema.Literals(["pending", "running", "completed", "failed", "aborted"]),
  task: Schema.String,
  description: Schema.optional(Schema.String),
  lastIntent: Schema.optional(Schema.String),
  currentTool: Schema.optional(Schema.String),
  toolCount: Schema.Number,
  tokens: Schema.Number,
});
const SubagentProgress = Schema.Struct({
  index: Schema.Number,
  agent: Schema.String,
  task: Schema.String,
  assignment: Schema.optional(Schema.String),
  parentToolCallId: Schema.optional(Schema.String),
  sessionFile: Schema.optional(Schema.String),
  progress: AgentProgress,
});
const decodeOmpModel = Schema.decodeUnknownOption(OmpModel);
const decodeSubagentLifecycle = Schema.decodeUnknownOption(SubagentLifecycle);
const decodeSubagentProgress = Schema.decodeUnknownOption(SubagentProgress);

function itemStatus(status: "started" | "completed" | "failed" | "aborted") {
  switch (status) {
    case "started":
      return "inProgress" as const;
    case "completed":
      return "completed" as const;
    case "failed":
      return "failed" as const;
    case "aborted":
      return "declined" as const;
  }
}

export function handlePiOmpControl(
  options: {
    readonly getTurn: () => PiTurnState | undefined;
    readonly emit: (event: PiSessionEvent) => Effect.Effect<void>;
    readonly applyConfig: (
      model: string | undefined,
      thinking: PiThinkingLevel | undefined,
    ) => Effect.Effect<void>;
    readonly refreshUsage: (turn: PiTurnState) => Effect.Effect<void>;
  },
  frame: PiControlFrame,
): Effect.Effect<boolean> {
  return Effect.gen(function* () {
    if (frame.type === "config_update") {
      const model = Option.getOrUndefined(decodeOmpModel(frame.model));
      yield* options.applyConfig(
        model === undefined ? undefined : `${model.provider}/${model.id}`,
        asPiThinkingLevel(frame.thinkingLevel),
      );
      return true;
    }
    if (frame.type === "notice") {
      if (frame.level !== "info") {
        const turn = options.getTurn();
        yield* options.emit({
          type: "runtime.warning",
          ...(turn ? { turnId: turn.turnId } : {}),
          payload: {
            message: frame.message,
            detail: { level: frame.level, source: frame.source },
          },
          raw: { source: "pi.rpc.control", method: frame.type, payload: frame },
        });
      }
      return true;
    }
    const turn = options.getTurn();
    if (frame.type === "subagent_lifecycle") {
      const payload = Option.getOrUndefined(decodeSubagentLifecycle(frame.payload));
      if (turn === undefined || payload === undefined) return true;
      const eventType = payload.status === "started" ? "item.started" : "item.completed";
      yield* options.emit({
        type: eventType,
        turnId: turn.turnId,
        itemId: RuntimeItemId.make(`omp-subagent:${payload.id}`),
        payload: {
          itemType: "collab_agent_tool_call",
          title: payload.description ?? payload.agent,
          status: itemStatus(payload.status),
          data: payload,
        },
        raw: { source: "pi.rpc.control", method: frame.type, payload: frame },
      });
      return true;
    }
    if (frame.type === "subagent_progress") {
      const payload = Option.getOrUndefined(decodeSubagentProgress(frame.payload));
      if (turn === undefined || payload === undefined) return true;
      yield* options.emit({
        type: "item.updated",
        turnId: turn.turnId,
        itemId: RuntimeItemId.make(`omp-subagent:${payload.progress.id}`),
        payload: {
          itemType: "collab_agent_tool_call",
          title: payload.task || payload.agent,
          status: itemStatus(
            payload.progress.status === "pending" || payload.progress.status === "running"
              ? "started"
              : payload.progress.status,
          ),
          ...(payload.progress.lastIntent !== undefined
            ? { detail: payload.progress.lastIntent }
            : payload.progress.currentTool !== undefined
              ? { detail: payload.progress.currentTool }
              : {}),
          data: payload,
        },
        raw: { source: "pi.rpc.control", method: frame.type, payload: frame },
      });
      return true;
    }
    if (frame.type === "auto_compaction_start") {
      if (turn !== undefined) {
        yield* options.emit({
          type: "item.started",
          turnId: turn.turnId,
          itemId: RuntimeItemId.make(`${turn.turnId}:compaction`),
          payload: {
            itemType: "context_compaction",
            title: "Compacting context",
            detail: frame.reason,
            status: "inProgress",
            data: { action: frame.action },
          },
        });
      }
      return true;
    }
    if (frame.type === "auto_compaction_end") {
      if (turn !== undefined) {
        yield* options.emit({
          type: "item.completed",
          turnId: turn.turnId,
          itemId: RuntimeItemId.make(`${turn.turnId}:compaction`),
          payload: {
            itemType: "context_compaction",
            title: frame.aborted ? "Context compaction stopped" : "Context compacted",
            status: frame.aborted ? "failed" : "completed",
            ...(frame.errorMessage !== undefined ? { detail: frame.errorMessage } : {}),
            data: frame,
          },
        });
        if (!frame.aborted && !frame.skipped) yield* options.refreshUsage(turn);
      }
      return true;
    }
    return false;
  });
}
