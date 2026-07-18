import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import {
  PI_THINKING_LEVELS,
  asPiThinkingLevel,
  decodeOption,
  decodeRollbackMessagesFor,
  decodeSessionStateFor,
  decodeSessionStatsFor,
  type PiContextCommand,
  type PiDiscoveredModel,
  type PiRpcDialectCodec,
  type PiThinkingEffortMapping,
} from "./PiRpcDialect.ts";
import type { PiThinkingLevel, RpcResponse } from "./PiRpcTypes.ts";

const PiModelEntry = Schema.Struct({
  provider: Schema.String,
  id: Schema.String,
  name: Schema.optional(Schema.String),
  reasoning: Schema.optional(Schema.Boolean),
  thinkingLevelMap: Schema.optional(Schema.Record(Schema.String, Schema.NullOr(Schema.String))),
});

const PiCommandEntry = Schema.Struct({
  name: Schema.String,
  description: Schema.optional(Schema.String),
  source: Schema.String,
  sourceInfo: Schema.Struct({
    path: Schema.String,
    scope: Schema.optional(Schema.String),
  }),
});

const CommandsData = Schema.Struct({ commands: Schema.Array(Schema.Unknown) });

function effortMappings(
  values: Readonly<Record<string, string | null>> | undefined,
): ReadonlyArray<PiThinkingEffortMapping> {
  if (values === undefined) return [];
  return Object.entries(values).flatMap(([key, value]) => {
    const level = asPiThinkingLevel(key);
    return level !== undefined && value !== null ? [{ level, value }] : [];
  });
}

function availableLevels(
  reasoning: boolean,
  values: Readonly<Record<string, string | null>> | undefined,
): ReadonlyArray<PiThinkingLevel> {
  if (!reasoning) return [];
  return PI_THINKING_LEVELS.filter((level) => {
    const mapped = values?.[level];
    if (mapped === null) return false;
    if (level === "xhigh" || level === "max") return mapped !== undefined;
    return true;
  });
}

function decodeModel(input: unknown): Option.Option<PiDiscoveredModel> {
  return Option.map(decodeOption(PiModelEntry, input), (model) => {
    const reasoning = model.reasoning === true;
    const thinkingLevels = availableLevels(reasoning, model.thinkingLevelMap);
    const defaultThinkingLevel = thinkingLevels.includes("medium") ? "medium" : undefined;
    return {
      provider: model.provider,
      id: model.id,
      ...(model.name !== undefined ? { name: model.name } : {}),
      reasoning,
      thinkingLevels,
      ...(defaultThinkingLevel !== undefined ? { defaultThinkingLevel } : {}),
      requiresThinking: false,
      effortMap: effortMappings(model.thinkingLevelMap),
    };
  });
}

function decodeCommands(response: RpcResponse | undefined): ReadonlyArray<PiContextCommand> {
  if (!response?.success || response.command !== "get_commands") return [];
  return Option.match(decodeOption(CommandsData, response.data), {
    onNone: () => [],
    onSome: ({ commands }) =>
      commands.flatMap((entry) => {
        const decoded = decodeOption(PiCommandEntry, entry);
        if (Option.isNone(decoded)) return [];
        const command = decoded.value;
        return [
          {
            name: command.name,
            ...(command.description !== undefined ? { description: command.description } : {}),
            source: command.source,
            path: command.sourceInfo.path,
            ...(command.sourceInfo.scope !== undefined ? { scope: command.sourceInfo.scope } : {}),
            aliases: [],
            subcommands: [],
          },
        ];
      }),
  });
}

export function makePiDialectCodec(): PiRpcDialectCodec {
  return {
    kind: "pi",
    listCommandsCommand: { type: "get_commands" },
    listRollbackMessagesCommand: { type: "get_fork_messages" },
    makeRollbackCommand: (entryId) => ({ type: "fork", entryId }),
    decodeModel,
    decodeCommands,
    decodeCommandUpdate: () => Option.none(),
    decodeRollbackMessages: (response) => decodeRollbackMessagesFor("get_fork_messages", response),
    decodeSessionState: decodeSessionStateFor,
    decodeSessionStats: decodeSessionStatsFor,
  };
}
