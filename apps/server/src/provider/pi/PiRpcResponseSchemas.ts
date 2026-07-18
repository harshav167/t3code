import * as Schema from "effect/Schema";

export const PiResponseEnvelope = Schema.Struct({
  type: Schema.Literal("response"),
  id: Schema.String,
  command: Schema.String,
  success: Schema.Boolean,
});

export const PiUncorrelatedResponse = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("response"),
    command: Schema.String,
    success: Schema.Literal(true),
  }),
  Schema.Struct({
    type: Schema.Literal("response"),
    command: Schema.String,
    success: Schema.Literal(false),
    error: Schema.String,
  }),
]);

const FailedResponse = Schema.Struct({
  type: Schema.Literal("response"),
  id: Schema.String,
  command: Schema.String,
  success: Schema.Literal(false),
  error: Schema.String,
});
const SessionStateResponse = Schema.Struct({
  type: Schema.Literal("response"),
  id: Schema.String,
  command: Schema.Literal("get_state"),
  success: Schema.Literal(true),
  data: Schema.Struct({
    sessionFile: Schema.optional(Schema.String),
    sessionId: Schema.String,
  }),
});
const AvailableModelsResponse = Schema.Struct({
  type: Schema.Literal("response"),
  id: Schema.String,
  command: Schema.Literal("get_available_models"),
  success: Schema.Literal(true),
  data: Schema.Struct({
    models: Schema.Array(
      Schema.Struct({
        provider: Schema.String,
        id: Schema.String,
        reasoning: Schema.optional(Schema.Boolean),
      }),
    ),
  }),
});
const ForkMessagesResponse = Schema.Struct({
  type: Schema.Literal("response"),
  id: Schema.String,
  command: Schema.Literal("get_fork_messages"),
  success: Schema.Literal(true),
  data: Schema.Struct({
    messages: Schema.Array(Schema.Struct({ entryId: Schema.String, text: Schema.String })),
  }),
});
const ForkResponse = Schema.Struct({
  type: Schema.Literal("response"),
  id: Schema.String,
  command: Schema.Literal("fork"),
  success: Schema.Literal(true),
  data: Schema.Struct({ text: Schema.String, cancelled: Schema.Boolean }),
});
const NewSessionResponse = Schema.Struct({
  type: Schema.Literal("response"),
  id: Schema.String,
  command: Schema.Literal("new_session"),
  success: Schema.Literal(true),
  data: Schema.Struct({ cancelled: Schema.Boolean }),
});
const LastAssistantTextResponse = Schema.Struct({
  type: Schema.Literal("response"),
  id: Schema.String,
  command: Schema.Literal("get_last_assistant_text"),
  success: Schema.Literal(true),
  data: Schema.Struct({ text: Schema.NullOr(Schema.String) }),
});
const CommandsResponse = Schema.Struct({
  type: Schema.Literal("response"),
  id: Schema.String,
  command: Schema.Literal("get_commands"),
  success: Schema.Literal(true),
  data: Schema.Struct({ commands: Schema.Array(Schema.Struct({ name: Schema.String })) }),
});
const AvailableCommandsResponse = Schema.Struct({
  type: Schema.Literal("response"),
  id: Schema.String,
  command: Schema.Literal("get_available_commands"),
  success: Schema.Literal(true),
  data: Schema.Struct({ commands: Schema.Array(Schema.Struct({ name: Schema.String })) }),
});
const BranchMessagesResponse = Schema.Struct({
  type: Schema.Literal("response"),
  id: Schema.String,
  command: Schema.Literal("get_branch_messages"),
  success: Schema.Literal(true),
  data: Schema.Struct({
    messages: Schema.Array(Schema.Struct({ entryId: Schema.String, text: Schema.String })),
  }),
});
const BranchResponse = Schema.Struct({
  type: Schema.Literal("response"),
  id: Schema.String,
  command: Schema.Literal("branch"),
  success: Schema.Literal(true),
  data: Schema.Struct({ text: Schema.String, cancelled: Schema.Boolean }),
});
const GenericSuccessResponse = Schema.Struct({
  type: Schema.Literal("response"),
  id: Schema.String,
  command: Schema.String,
  success: Schema.Literal(true),
});

export function piResponseSchema(command: string, success: boolean): Schema.Top {
  if (!success) return FailedResponse;
  switch (command) {
    case "get_state":
      return SessionStateResponse;
    case "get_available_models":
      return AvailableModelsResponse;
    case "get_fork_messages":
      return ForkMessagesResponse;
    case "fork":
      return ForkResponse;
    case "new_session":
      return NewSessionResponse;
    case "get_last_assistant_text":
      return LastAssistantTextResponse;
    case "get_commands":
      return CommandsResponse;
    case "get_available_commands":
      return AvailableCommandsResponse;
    case "get_branch_messages":
      return BranchMessagesResponse;
    case "branch":
      return BranchResponse;
    default:
      return GenericSuccessResponse;
  }
}
