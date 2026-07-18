export interface RpcResponse {
  readonly type: "response";
  readonly id?: string;
  readonly command: string;
  readonly success: boolean;
  readonly data?: unknown;
  readonly error?: string;
}

export type PiThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export interface ModelInfo {
  readonly provider: string;
  readonly id: string;
  readonly name?: string;
  readonly reasoning?: boolean;
  readonly thinkingLevelMap?: Partial<Record<PiThinkingLevel, string | null>>;
}

export interface PiImageContent {
  readonly type: "image";
  readonly data: string;
  readonly mimeType: string;
}

export type RpcCommand =
  | {
      readonly id?: string;
      readonly type: "prompt" | "steer";
      readonly message: string;
      readonly images?: ReadonlyArray<PiImageContent>;
    }
  | {
      readonly id?: string;
      readonly type:
        | "get_state"
        | "get_available_models"
        | "get_commands"
        | "get_fork_messages"
        | "get_session_stats"
        | "get_last_assistant_text"
        | "abort"
        | "new_session";
    }
  | {
      readonly id?: string;
      readonly type: "set_model";
      readonly provider: string;
      readonly modelId: string;
    }
  | { readonly id?: string; readonly type: "set_thinking_level"; readonly level: PiThinkingLevel }
  | { readonly id?: string; readonly type: "fork"; readonly entryId: string }
  | { readonly id?: string; readonly type: "get_available_commands" }
  | { readonly id?: string; readonly type: "get_branch_messages" }
  | { readonly id?: string; readonly type: "branch"; readonly entryId: string };

type AssistantMessageEvent =
  | {
      readonly type: "text_delta" | "thinking_delta";
      readonly contentIndex: number;
      readonly delta: string;
    }
  | {
      readonly type: "start" | "done" | "error";
    }
  | {
      readonly type:
        | "text_start"
        | "text_end"
        | "thinking_start"
        | "thinking_end"
        | "toolcall_start"
        | "toolcall_delta"
        | "toolcall_end";
      readonly contentIndex: number;
    };

export type AgentSessionEvent =
  | {
      readonly type: "message_update";
      readonly message?: unknown;
      readonly assistantMessageEvent: AssistantMessageEvent;
    }
  | {
      readonly type: "tool_execution_start";
      readonly toolCallId: string;
      readonly toolName: string;
      readonly args: unknown;
    }
  | {
      readonly type: "tool_execution_update";
      readonly toolCallId: string;
      readonly toolName: string;
      readonly args?: unknown;
      readonly partialResult: unknown;
    }
  | {
      readonly type: "tool_execution_end";
      readonly toolCallId: string;
      readonly toolName: string;
      readonly result: unknown;
      readonly isError?: boolean;
    }
  | {
      readonly type: "agent_end";
      readonly messages: ReadonlyArray<unknown>;
      readonly willRetry?: boolean;
    }
  | {
      readonly type:
        | "agent_start"
        | "agent_settled"
        | "turn_start"
        | "turn_end"
        | "message_start"
        | "message_end"
        | "queue_update"
        | "compaction_start"
        | "compaction_end"
        | "auto_retry_start"
        | "auto_retry_end"
        | "extension_error"
        | "entry_appended"
        | "session_info_changed"
        | "thinking_level_changed";
      readonly [key: string]: unknown;
    };

export type { PiControlFrame } from "./PiRpcControlTypes.ts";
export type { RpcExtensionUIRequest, RpcExtensionUIResponse } from "./PiRpcExtensionTypes.ts";
