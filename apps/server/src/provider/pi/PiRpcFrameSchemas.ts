import * as Schema from "effect/Schema";

export { PiExtensionRequestSchemas } from "./PiRpcExtensionSchemas.ts";

const ObjectEnvelope = Schema.Struct({ type: Schema.String });

export const PiEventSchemas = {
  agent_start: ObjectEnvelope,
  agent_end: Schema.Struct({
    type: Schema.Literal("agent_end"),
    messages: Schema.Array(Schema.Unknown),
    willRetry: Schema.optional(Schema.Boolean),
  }),
  agent_settled: ObjectEnvelope,
  turn_start: ObjectEnvelope,
  turn_end: Schema.Struct({
    type: Schema.Literal("turn_end"),
    message: Schema.Unknown,
    toolResults: Schema.Array(Schema.Unknown),
  }),
  message_start: Schema.Struct({ type: Schema.Literal("message_start"), message: Schema.Unknown }),
  message_update: Schema.Struct({
    type: Schema.Literal("message_update"),
    message: Schema.optional(Schema.Unknown),
    assistantMessageEvent: Schema.Union([
      Schema.Struct({
        type: Schema.Literal("text_delta"),
        contentIndex: Schema.Number,
        delta: Schema.String,
      }),
      Schema.Struct({
        type: Schema.Literal("thinking_delta"),
        contentIndex: Schema.Number,
        delta: Schema.String,
      }),
      Schema.Struct({
        type: Schema.Literals(["start", "done", "error"]),
      }),
      Schema.Struct({
        type: Schema.Literals([
          "text_start",
          "text_end",
          "thinking_start",
          "thinking_end",
          "toolcall_start",
          "toolcall_delta",
          "toolcall_end",
        ]),
        contentIndex: Schema.Number,
      }),
    ]),
  }),
  message_end: Schema.Struct({ type: Schema.Literal("message_end"), message: Schema.Unknown }),
  tool_execution_start: Schema.Struct({
    type: Schema.Literal("tool_execution_start"),
    toolCallId: Schema.String,
    toolName: Schema.String,
    args: Schema.Unknown,
  }),
  tool_execution_update: Schema.Struct({
    type: Schema.Literal("tool_execution_update"),
    toolCallId: Schema.String,
    toolName: Schema.String,
    args: Schema.optional(Schema.Unknown),
    partialResult: Schema.Unknown,
  }),
  tool_execution_end: Schema.Struct({
    type: Schema.Literal("tool_execution_end"),
    toolCallId: Schema.String,
    toolName: Schema.String,
    result: Schema.Unknown,
    isError: Schema.optional(Schema.Boolean),
  }),
  queue_update: Schema.Struct({
    type: Schema.Literal("queue_update"),
    steering: Schema.Array(Schema.String),
    followUp: Schema.Array(Schema.String),
  }),
  compaction_start: Schema.Struct({
    type: Schema.Literal("compaction_start"),
    reason: Schema.String,
  }),
  compaction_end: Schema.Struct({
    type: Schema.Literal("compaction_end"),
    reason: Schema.String,
    aborted: Schema.Boolean,
    willRetry: Schema.Boolean,
  }),
  auto_retry_start: Schema.Struct({
    type: Schema.Literal("auto_retry_start"),
    attempt: Schema.Number,
    maxAttempts: Schema.Number,
    delayMs: Schema.Number,
    errorMessage: Schema.String,
  }),
  auto_retry_end: Schema.Struct({
    type: Schema.Literal("auto_retry_end"),
    success: Schema.Boolean,
    attempt: Schema.Number,
  }),
  extension_error: Schema.Struct({
    type: Schema.Literal("extension_error"),
    error: Schema.Unknown,
  }),
  entry_appended: Schema.Struct({ type: Schema.Literal("entry_appended"), entry: Schema.Unknown }),
  session_info_changed: Schema.Struct({
    type: Schema.Literal("session_info_changed"),
    name: Schema.optional(Schema.String),
  }),
  thinking_level_changed: Schema.Struct({
    type: Schema.Literal("thinking_level_changed"),
    level: Schema.optional(Schema.String),
    thinkingLevel: Schema.optional(Schema.String),
  }),
} as const;

export const PiControlFrameSchemas = {
  ready: Schema.Struct({ type: Schema.Literal("ready") }),
  available_commands_update: Schema.Struct({
    type: Schema.Literal("available_commands_update"),
    commands: Schema.Array(
      Schema.Struct({
        name: Schema.String,
        aliases: Schema.optional(Schema.Array(Schema.String)),
        description: Schema.optional(Schema.String),
        input: Schema.optional(Schema.Struct({ hint: Schema.optional(Schema.String) })),
        subcommands: Schema.optional(
          Schema.Array(
            Schema.Struct({
              name: Schema.String,
              description: Schema.optional(Schema.String),
              usage: Schema.optional(Schema.String),
            }),
          ),
        ),
        source: Schema.String,
      }),
    ),
  }),
  prompt_result: Schema.Struct({
    type: Schema.Literal("prompt_result"),
    id: Schema.optional(Schema.String),
    agentInvoked: Schema.Boolean,
  }),
  subagent_lifecycle: Schema.Struct({
    type: Schema.Literal("subagent_lifecycle"),
    payload: Schema.Unknown,
  }),
  subagent_progress: Schema.Struct({
    type: Schema.Literal("subagent_progress"),
    payload: Schema.Unknown,
  }),
  subagent_event: Schema.Struct({
    type: Schema.Literal("subagent_event"),
    payload: Schema.Unknown,
  }),
  command_output: Schema.Struct({
    type: Schema.Literal("command_output"),
    text: Schema.String,
  }),
  session_info_update: Schema.Struct({
    type: Schema.Literal("session_info_update"),
    sessionId: Schema.String,
    title: Schema.optional(Schema.String),
  }),
  config_update: Schema.Struct({
    type: Schema.Literal("config_update"),
    model: Schema.optional(Schema.Unknown),
    thinkingLevel: Schema.optional(Schema.String),
  }),
  auto_compaction_start: Schema.Struct({
    type: Schema.Literal("auto_compaction_start"),
    reason: Schema.String,
    action: Schema.String,
  }),
  auto_compaction_end: Schema.Struct({
    type: Schema.Literal("auto_compaction_end"),
    action: Schema.optional(Schema.String),
    result: Schema.optional(Schema.Unknown),
    aborted: Schema.Boolean,
    willRetry: Schema.Boolean,
    errorMessage: Schema.optional(Schema.String),
    skipped: Schema.optional(Schema.Boolean),
  }),
  retry_fallback_applied: ObjectEnvelope,
  retry_fallback_succeeded: ObjectEnvelope,
  ttsr_triggered: ObjectEnvelope,
  todo_reminder: ObjectEnvelope,
  todo_auto_clear: ObjectEnvelope,
  irc_message: ObjectEnvelope,
  notice: Schema.Struct({
    type: Schema.Literal("notice"),
    level: Schema.Literals(["info", "warning", "error"]),
    message: Schema.String,
    source: Schema.optional(Schema.String),
  }),
  goal_updated: ObjectEnvelope,
} as const;
