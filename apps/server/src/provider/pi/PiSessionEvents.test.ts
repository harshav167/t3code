import { describe, expect, it } from "@effect/vitest";

import type { AgentSessionEvent } from "./PiRpcProtocol.ts";
import { piContentDelta } from "./PiContent.ts";
import { piAgentEndOutcome } from "./PiSessionLifecycle.ts";

const event = (value: unknown): AgentSessionEvent => value as AgentSessionEvent;

describe("piContentDelta", () => {
  it("maps text and thinking deltas without exposing other stream frames", () => {
    expect(
      piContentDelta(
        event({
          type: "message_update",
          assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "hello" },
        }),
      ),
    ).toEqual({ streamKind: "assistant_text", delta: "hello", contentIndex: 0 });
    expect(
      piContentDelta(
        event({
          type: "message_update",
          assistantMessageEvent: { type: "thinking_delta", contentIndex: 1, delta: "why" },
        }),
      ),
    ).toEqual({ streamKind: "reasoning_text", delta: "why", contentIndex: 1 });
    expect(
      piContentDelta(
        event({
          type: "message_update",
          assistantMessageEvent: { type: "toolcall_delta", contentIndex: 2 },
        }),
      ),
    ).toBeNull();
  });
});

describe("piAgentEndOutcome", () => {
  it("waits through Pi retries and completes an OMP terminal event without willRetry", () => {
    expect(
      piAgentEndOutcome(event({ type: "agent_end", messages: [], willRetry: true })),
    ).toBeNull();
    expect(piAgentEndOutcome(event({ type: "agent_end", messages: [] }))).toEqual({
      state: "completed",
    });
  });

  it("surfaces the final assistant error", () => {
    expect(
      piAgentEndOutcome(
        event({
          type: "agent_end",
          messages: [
            {
              role: "assistant",
              stopReason: "error",
              errorMessage: "Connection error.",
            },
          ],
        }),
      ),
    ).toEqual({ state: "failed", errorMessage: "Connection error." });
  });
});
