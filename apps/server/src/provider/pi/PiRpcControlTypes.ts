export type PiControlFrame =
  | { readonly type: "ready" }
  | {
      readonly type: "available_commands_update";
      readonly commands: ReadonlyArray<{
        readonly name: string;
        readonly aliases?: ReadonlyArray<string>;
        readonly description?: string;
        readonly input?: { readonly hint?: string };
        readonly subcommands?: ReadonlyArray<{
          readonly name: string;
          readonly description?: string;
          readonly usage?: string;
        }>;
        readonly source: string;
      }>;
    }
  | { readonly type: "prompt_result"; readonly id?: string; readonly agentInvoked: boolean }
  | {
      readonly type: "subagent_lifecycle" | "subagent_progress" | "subagent_event";
      readonly payload: unknown;
    }
  | { readonly type: "command_output"; readonly text: string }
  | { readonly type: "session_info_update"; readonly sessionId: string; readonly title?: string }
  | { readonly type: "config_update"; readonly model?: unknown; readonly thinkingLevel?: string }
  | { readonly type: "auto_compaction_start"; readonly reason: string; readonly action: string }
  | {
      readonly type: "auto_compaction_end";
      readonly action?: string;
      readonly result?: unknown;
      readonly aborted: boolean;
      readonly willRetry: boolean;
      readonly errorMessage?: string;
      readonly skipped?: boolean;
    }
  | {
      readonly type: "notice";
      readonly level: "info" | "warning" | "error";
      readonly message: string;
      readonly source?: string;
    }
  | {
      readonly type:
        | "retry_fallback_applied"
        | "retry_fallback_succeeded"
        | "ttsr_triggered"
        | "todo_reminder"
        | "todo_auto_clear"
        | "irc_message"
        | "goal_updated";
      readonly [key: string]: unknown;
    };
