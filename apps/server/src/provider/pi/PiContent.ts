import type { RuntimeContentStreamKind } from "@t3tools/contracts";

import type { AgentSessionEvent } from "./PiRpcProtocol.ts";

export interface PiContentDelta {
  readonly streamKind: Extract<RuntimeContentStreamKind, "assistant_text" | "reasoning_text">;
  readonly delta: string;
}

export function piContentDelta(event: AgentSessionEvent): PiContentDelta | null {
  if (event.type !== "message_update") return null;
  const update = event.assistantMessageEvent;
  if (update.type === "text_delta") {
    return { streamKind: "assistant_text", delta: update.delta };
  }
  if (update.type === "thinking_delta") {
    return { streamKind: "reasoning_text", delta: update.delta };
  }
  return null;
}
