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

export interface RpcExtensionUIResponse {
  readonly type: "extension_ui_response";
  readonly id: string;
  readonly confirmed?: boolean;
  readonly value?: string;
  readonly cancelled?: boolean;
}

type AssistantMessageEvent =
  | { readonly type: "text_delta" | "thinking_delta"; readonly delta: string }
  | {
      readonly type:
        | "start"
        | "text_start"
        | "text_end"
        | "thinking_start"
        | "thinking_end"
        | "toolcall_start"
        | "toolcall_delta"
        | "toolcall_end"
        | "done"
        | "error";
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

export type PiControlFrame =
  | { readonly type: "ready" }
  | {
      readonly type: "available_commands_update";
      readonly commands: ReadonlyArray<{ readonly name: string }>;
    }
  | { readonly type: "prompt_result"; readonly id: string; readonly agentInvoked: boolean }
  | {
      readonly type: "subagent_lifecycle" | "subagent_progress" | "subagent_event";
      readonly payload: unknown;
    }
  | { readonly type: "command_output"; readonly text: string }
  | { readonly type: "session_info_update"; readonly sessionId: string; readonly title?: string }
  | { readonly type: "config_update"; readonly model?: unknown; readonly thinkingLevel?: string }
  | {
      readonly type:
        | "auto_compaction_start"
        | "auto_compaction_end"
        | "retry_fallback_applied"
        | "retry_fallback_succeeded"
        | "ttsr_triggered"
        | "todo_reminder"
        | "todo_auto_clear"
        | "irc_message"
        | "notice"
        | "goal_updated";
      readonly [key: string]: unknown;
    };

export type RpcExtensionUIRequest =
  | {
      readonly type: "extension_ui_request";
      readonly id: string;
      readonly method: "select";
      readonly title: string;
      readonly options: ReadonlyArray<string>;
      readonly timeout?: number;
    }
  | {
      readonly type: "extension_ui_request";
      readonly id: string;
      readonly method: "confirm";
      readonly title: string;
      readonly message: string;
      readonly timeout?: number;
    }
  | {
      readonly type: "extension_ui_request";
      readonly id: string;
      readonly method: "input";
      readonly title: string;
      readonly placeholder?: string;
      readonly timeout?: number;
    }
  | {
      readonly type: "extension_ui_request";
      readonly id: string;
      readonly method: "editor";
      readonly title: string;
      readonly prefill?: string;
    }
  | {
      readonly type: "extension_ui_request";
      readonly id: string;
      readonly method: "notify";
      readonly message: string;
    }
  | {
      readonly type: "extension_ui_request";
      readonly id: string;
      readonly method: "setStatus";
      readonly statusKey: string;
      readonly statusText?: string;
    }
  | {
      readonly type: "extension_ui_request";
      readonly id: string;
      readonly method: "setWidget";
      readonly widgetKey: string;
      readonly widgetLines?: ReadonlyArray<string>;
    }
  | {
      readonly type: "extension_ui_request";
      readonly id: string;
      readonly method: "setTitle";
      readonly title: string;
    }
  | {
      readonly type: "extension_ui_request";
      readonly id: string;
      readonly method: "set_editor_text";
      readonly text: string;
    }
  | {
      readonly type: "extension_ui_request";
      readonly id: string;
      readonly method: "cancel";
      readonly targetId: string;
    }
  | {
      readonly type: "extension_ui_request";
      readonly id: string;
      readonly method: "open_url";
      readonly url: string;
      readonly launchUrl?: string;
      readonly instructions?: string;
    };
