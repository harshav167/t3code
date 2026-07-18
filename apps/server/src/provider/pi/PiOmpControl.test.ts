import { TurnId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { handlePiOmpControl } from "./PiOmpControl.ts";
import type { PiControlFrame } from "./PiRpcTypes.ts";
import type { PiSessionEvent } from "./PiSessionEvents.ts";

describe("OMP control frames", () => {
  it.effect("projects config, subagent progress, notices, and compaction", () =>
    Effect.gen(function* () {
      const events: Array<PiSessionEvent> = [];
      const configs: Array<ReadonlyArray<string | undefined>> = [];
      let usageRefreshes = 0;
      const options = {
        getTurn: () => ({ turnId: TurnId.make("turn-omp"), items: [] }),
        emit: (event: PiSessionEvent) => Effect.sync(() => events.push(event)).pipe(Effect.asVoid),
        applyConfig: (model: string | undefined, thinking: string | undefined) =>
          Effect.sync(() => configs.push([model, thinking])).pipe(Effect.asVoid),
        refreshUsage: () =>
          Effect.sync(() => {
            usageRefreshes += 1;
          }),
      };
      const frames: ReadonlyArray<PiControlFrame> = [
        {
          type: "config_update",
          model: { provider: "openai-codex", id: "gpt-5.6-sol" },
          thinkingLevel: "xhigh",
        },
        {
          type: "subagent_lifecycle",
          payload: { id: "SubagentA", index: 0, agent: "task", status: "started" },
        },
        {
          type: "subagent_progress",
          payload: {
            index: 0,
            agent: "task",
            task: "Inspect code",
            progress: {
              id: "SubagentA",
              status: "running",
              task: "Inspect code",
              currentTool: "read",
              toolCount: 2,
              tokens: 400,
            },
          },
        },
        { type: "notice", level: "warning", message: "Fallback applied", source: "retry" },
        { type: "auto_compaction_start", reason: "threshold", action: "context-full" },
        {
          type: "auto_compaction_end",
          action: "context-full",
          aborted: false,
          willRetry: false,
        },
      ];
      for (const frame of frames) yield* handlePiOmpControl(options, frame);
      expect(configs).toEqual([["openai-codex/gpt-5.6-sol", "xhigh"]]);
      expect(events.map((event) => event.type)).toEqual([
        "item.started",
        "item.updated",
        "runtime.warning",
        "item.started",
        "item.completed",
      ]);
      expect(events[0]).toMatchObject({
        itemId: "omp-subagent:SubagentA",
        payload: { itemType: "collab_agent_tool_call", status: "inProgress" },
      });
      expect(events[4]).toMatchObject({
        itemId: "turn-omp:compaction",
        payload: { itemType: "context_compaction", status: "completed" },
      });
      expect(usageRefreshes).toBe(1);
    }),
  );
});
