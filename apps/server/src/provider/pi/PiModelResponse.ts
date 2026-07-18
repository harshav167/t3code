import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { PI_THINKING_LEVELS } from "./PiRpcDialect.ts";
import type { ModelInfo, PiThinkingLevel, RpcResponse } from "./PiRpcTypes.ts";

const SessionFileData = Schema.Struct({ sessionFile: Schema.optional(Schema.String) });
const PromptData = Schema.Struct({ agentInvoked: Schema.optional(Schema.Boolean) });
const AvailableModelsData = Schema.Struct({
  models: Schema.Array(Schema.Unknown),
});
const AvailableModel = Schema.Struct({
  provider: Schema.String,
  id: Schema.String,
  name: Schema.optional(Schema.String),
  reasoning: Schema.optional(Schema.Boolean),
  thinkingLevelMap: Schema.optional(Schema.Record(Schema.String, Schema.NullOr(Schema.String))),
});
const CommandsData = Schema.Struct({
  commands: Schema.Array(Schema.Struct({ name: Schema.String })),
});
const LastAssistantTextData = Schema.Struct({ text: Schema.NullOr(Schema.String) });
const ForkMessagesData = Schema.Struct({
  messages: Schema.Array(Schema.Unknown),
});
const ForkMessage = Schema.Struct({ entryId: Schema.String, text: Schema.optional(Schema.String) });
const CancelledData = Schema.Struct({ cancelled: Schema.optional(Schema.Boolean) });
const decodeSessionFileData = Schema.decodeUnknownOption(SessionFileData);
const decodePromptData = Schema.decodeUnknownOption(PromptData);
const decodeAvailableModelsData = Schema.decodeUnknownOption(AvailableModelsData);
const decodeAvailableModel = Schema.decodeUnknownOption(AvailableModel);
const decodeCommandsData = Schema.decodeUnknownOption(CommandsData);
const decodeLastAssistantTextData = Schema.decodeUnknownOption(LastAssistantTextData);
const decodeForkMessagesData = Schema.decodeUnknownOption(ForkMessagesData);
const decodeForkMessage = Schema.decodeUnknownOption(ForkMessage);
const decodeCancelledData = Schema.decodeUnknownOption(CancelledData);

function successfulData(response: RpcResponse | undefined): unknown {
  return response?.success ? response.data : undefined;
}

function thinkingMap(
  input: Readonly<Record<string, string | null>>,
): Partial<Record<PiThinkingLevel, string | null>> {
  const result: Partial<Record<PiThinkingLevel, string | null>> = {};
  for (const level of PI_THINKING_LEVELS) {
    const value = input[level];
    if (value !== undefined) result[level] = value;
  }
  return result;
}

export function piPromptAgentInvoked(response: RpcResponse | undefined): boolean | undefined {
  if (!piResponseSucceeded(response, "prompt")) return undefined;
  return Option.getOrUndefined(decodePromptData(successfulData(response)))?.agentInvoked;
}

export function extractSessionFile(response: RpcResponse | undefined): string | undefined {
  const sessionFile = Option.getOrUndefined(
    decodeSessionFileData(successfulData(response)),
  )?.sessionFile;
  return sessionFile?.trim() || undefined;
}

export function extractAvailableModels(
  response: RpcResponse | undefined,
): ReadonlyArray<ModelInfo> {
  const decoded = Option.getOrUndefined(decodeAvailableModelsData(successfulData(response)));
  return (
    decoded?.models.flatMap((input) =>
      Option.toArray(decodeAvailableModel(input)).map((model) => ({
        provider: model.provider,
        id: model.id,
        ...(model.name !== undefined ? { name: model.name } : {}),
        ...(model.reasoning !== undefined ? { reasoning: model.reasoning } : {}),
        ...(model.thinkingLevelMap !== undefined
          ? { thinkingLevelMap: thinkingMap(model.thinkingLevelMap) }
          : {}),
      })),
    ) ?? []
  );
}

export function piResponseHasCommand(
  response: RpcResponse | undefined,
  commandName: string,
): boolean {
  const decoded = Option.getOrUndefined(decodeCommandsData(successfulData(response)));
  return decoded?.commands.some((command) => command.name === commandName) ?? false;
}

export function extractLastAssistantText(response: RpcResponse | undefined): string | null {
  return Option.getOrUndefined(decodeLastAssistantTextData(successfulData(response)))?.text ?? null;
}

export function piResponseSucceeded(response: RpcResponse | undefined, command: string): boolean {
  return Boolean(response?.success && response.command === command);
}

export function extractForkMessages(
  response: RpcResponse | undefined,
): ReadonlyArray<{ readonly entryId: string; readonly text: string }> {
  const decoded = Option.getOrUndefined(decodeForkMessagesData(successfulData(response)));
  return (
    decoded?.messages.flatMap((input) =>
      Option.toArray(decodeForkMessage(input)).map((message) => ({
        entryId: message.entryId,
        text: message.text ?? "",
      })),
    ) ?? []
  );
}

export function piForkSucceeded(response: RpcResponse | undefined): boolean {
  const cancelled = Option.getOrUndefined(decodeCancelledData(successfulData(response)))?.cancelled;
  return response?.success === true && cancelled !== true;
}

export function resolveForkTargetEntryId(
  userMessages: ReadonlyArray<{ readonly entryId: string }>,
  numTurns: number,
): { readonly kind: "fork"; readonly entryId: string } | { readonly kind: "reset" } | null {
  if (numTurns <= 0 || userMessages.length === 0) return null;
  const targetIndex = userMessages.length - numTurns;
  if (targetIndex <= 0) return { kind: "reset" };
  const target = userMessages[targetIndex];
  return target === undefined ? null : { kind: "fork", entryId: target.entryId };
}
