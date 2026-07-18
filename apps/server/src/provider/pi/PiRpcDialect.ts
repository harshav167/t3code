import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import type { PiControlFrame, PiThinkingLevel, RpcCommand, RpcResponse } from "./PiRpcTypes.ts";

export interface PiThinkingEffortMapping {
  readonly level: PiThinkingLevel;
  readonly value: string;
}

export interface PiDiscoveredModel {
  readonly provider: string;
  readonly id: string;
  readonly name?: string;
  readonly reasoning: boolean;
  readonly thinkingLevels: ReadonlyArray<PiThinkingLevel>;
  readonly defaultThinkingLevel?: PiThinkingLevel;
  readonly requiresThinking: boolean;
  readonly effortMap: ReadonlyArray<PiThinkingEffortMapping>;
}

export interface PiContextCommand {
  readonly name: string;
  readonly description?: string;
  readonly source: string;
  readonly path?: string;
  readonly scope?: string;
  readonly aliases: ReadonlyArray<string>;
  readonly inputHint?: string;
  readonly subcommands: ReadonlyArray<{
    readonly name: string;
    readonly description?: string;
    readonly usage?: string;
  }>;
}

export interface PiRollbackMessage {
  readonly entryId: string;
  readonly text: string;
}

export interface PiSessionState {
  readonly sessionId?: string;
  readonly sessionFile?: string;
  readonly thinkingLevel?: string;
  readonly queuedCount?: number;
}

export interface PiSessionStats {
  readonly toolCalls: number;
  readonly tokens: {
    readonly input: number;
    readonly output: number;
    readonly reasoning?: number | undefined;
    readonly cacheRead: number;
    readonly cacheWrite: number;
    readonly total: number;
  };
  readonly contextUsage?:
    | {
        readonly tokens: number | null;
        readonly contextWindow: number;
        readonly percent?: number | null | undefined;
      }
    | undefined;
}

export interface PiRpcDialectCodec {
  readonly kind: "pi" | "omp";
  readonly listCommandsCommand: RpcCommand;
  readonly listRollbackMessagesCommand: RpcCommand;
  readonly makeRollbackCommand: (entryId: string) => RpcCommand;
  readonly decodeModel: (input: unknown) => Option.Option<PiDiscoveredModel>;
  readonly decodeCommands: (response: RpcResponse | undefined) => ReadonlyArray<PiContextCommand>;
  readonly decodeCommandUpdate: (
    frame: PiControlFrame,
  ) => Option.Option<ReadonlyArray<PiContextCommand>>;
  readonly decodeRollbackMessages: (
    response: RpcResponse | undefined,
  ) => ReadonlyArray<PiRollbackMessage>;
  readonly decodeSessionState: (response: RpcResponse | undefined) => Option.Option<PiSessionState>;
  readonly decodeSessionStats: (response: RpcResponse | undefined) => Option.Option<PiSessionStats>;
}

export const PI_THINKING_LEVELS: ReadonlyArray<PiThinkingLevel> = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

export function asPiThinkingLevel(value: string | undefined): PiThinkingLevel | undefined {
  switch (value) {
    case "off":
    case "minimal":
    case "low":
    case "medium":
    case "high":
    case "xhigh":
    case "max":
      return value;
    case undefined:
    default:
      return undefined;
  }
}

export function decodeOption<S extends Schema.Decoder<unknown>>(
  schema: S,
  input: unknown,
): Option.Option<S["Type"]> {
  return Schema.decodeUnknownOption(schema)(input);
}

const RollbackMessagesData = Schema.Struct({
  messages: Schema.Array(
    Schema.Struct({ entryId: Schema.String, text: Schema.optional(Schema.String) }),
  ),
});

const SessionStateData = Schema.Struct({
  sessionId: Schema.optional(Schema.String),
  sessionFile: Schema.optional(Schema.String),
  thinkingLevel: Schema.optional(Schema.String),
  pendingMessageCount: Schema.optional(Schema.Number),
  queuedMessageCount: Schema.optional(Schema.Number),
});

const SessionStatsData = Schema.Struct({
  toolCalls: Schema.Number,
  tokens: Schema.Struct({
    input: Schema.Number,
    output: Schema.Number,
    reasoning: Schema.optional(Schema.Number),
    cacheRead: Schema.Number,
    cacheWrite: Schema.Number,
    total: Schema.Number,
  }),
  contextUsage: Schema.optional(
    Schema.Struct({
      tokens: Schema.NullOr(Schema.Number),
      contextWindow: Schema.Number,
      percent: Schema.optional(Schema.NullOr(Schema.Number)),
    }),
  ),
});

export function decodeRollbackMessagesFor(
  command: string,
  response: RpcResponse | undefined,
): ReadonlyArray<PiRollbackMessage> {
  if (!response?.success || response.command !== command) return [];
  return Option.match(decodeOption(RollbackMessagesData, response.data), {
    onNone: () => [],
    onSome: ({ messages }) =>
      messages.map((message) => ({ entryId: message.entryId, text: message.text ?? "" })),
  });
}

export function decodeSessionStateFor(
  response: RpcResponse | undefined,
): Option.Option<PiSessionState> {
  if (!response?.success || response.command !== "get_state") return Option.none();
  return Option.map(decodeOption(SessionStateData, response.data), (state) => {
    const queuedCount = state.pendingMessageCount ?? state.queuedMessageCount;
    return {
      ...(state.sessionId !== undefined ? { sessionId: state.sessionId } : {}),
      ...(state.sessionFile !== undefined ? { sessionFile: state.sessionFile } : {}),
      ...(state.thinkingLevel !== undefined ? { thinkingLevel: state.thinkingLevel } : {}),
      ...(queuedCount !== undefined ? { queuedCount } : {}),
    };
  });
}

export function decodeSessionStatsFor(
  response: RpcResponse | undefined,
): Option.Option<PiSessionStats> {
  if (!response?.success || response.command !== "get_session_stats") return Option.none();
  return decodeOption(SessionStatsData, response.data);
}

const AvailableModelsData = Schema.Struct({ models: Schema.Array(Schema.Unknown) });

export function decodeAvailableModels(
  codec: PiRpcDialectCodec,
  response: RpcResponse | undefined,
): ReadonlyArray<PiDiscoveredModel> {
  if (!response?.success || response.command !== "get_available_models") return [];
  return Option.match(decodeOption(AvailableModelsData, response.data), {
    onNone: () => [],
    onSome: ({ models }) => models.flatMap((model) => Option.toArray(codec.decodeModel(model))),
  });
}

const PromptResponseData = Schema.Struct({ agentInvoked: Schema.optional(Schema.Boolean) });
const CancelledResponseData = Schema.Struct({ cancelled: Schema.optional(Schema.Boolean) });
const LastAssistantTextData = Schema.Struct({ text: Schema.NullOr(Schema.String) });

export function piResponseSucceeded(response: RpcResponse | undefined, command: string): boolean {
  return Boolean(response?.success && response.command === command);
}

export function piPromptAgentInvoked(response: RpcResponse | undefined): boolean | undefined {
  if (!response?.success || response.command !== "prompt") return undefined;
  return Option.getOrUndefined(decodeOption(PromptResponseData, response.data))?.agentInvoked;
}

export function piRollbackSucceeded(response: RpcResponse | undefined): boolean {
  if (!response?.success) return false;
  return (
    Option.getOrUndefined(decodeOption(CancelledResponseData, response.data))?.cancelled !== true
  );
}

export function extractLastAssistantText(response: RpcResponse | undefined): string | null {
  if (!response?.success || response.command !== "get_last_assistant_text") return null;
  return Option.getOrUndefined(decodeOption(LastAssistantTextData, response.data))?.text ?? null;
}
