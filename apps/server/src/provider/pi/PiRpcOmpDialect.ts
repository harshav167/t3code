import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import {
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
import type { PiControlFrame, PiThinkingLevel, RpcResponse } from "./PiRpcTypes.ts";

const OmpThinking = Schema.Struct({
  efforts: Schema.Array(Schema.String),
  defaultLevel: Schema.optional(Schema.String),
  effortMap: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  requiresEffort: Schema.optional(Schema.Boolean),
});

const OmpModelEntry = Schema.Struct({
  provider: Schema.String,
  id: Schema.String,
  name: Schema.optional(Schema.String),
  reasoning: Schema.optional(Schema.Boolean),
  thinking: Schema.optional(OmpThinking),
});

const OmpSubcommand = Schema.Struct({
  name: Schema.String,
  description: Schema.optional(Schema.String),
  usage: Schema.optional(Schema.String),
});

const OmpCommandEntry = Schema.Struct({
  name: Schema.String,
  aliases: Schema.optional(Schema.Array(Schema.String)),
  description: Schema.optional(Schema.String),
  input: Schema.optional(Schema.Struct({ hint: Schema.optional(Schema.String) })),
  subcommands: Schema.optional(Schema.Array(OmpSubcommand)),
  source: Schema.String,
});

const CommandsData = Schema.Struct({ commands: Schema.Array(Schema.Unknown) });

function effortMappings(
  values: Readonly<Record<string, string>> | undefined,
): ReadonlyArray<PiThinkingEffortMapping> {
  if (values === undefined) return [];
  return Object.entries(values).flatMap(([key, value]) => {
    const level = asPiThinkingLevel(key);
    return level !== undefined && level !== "off" ? [{ level, value }] : [];
  });
}

function effortLevels(input: ReadonlyArray<string>): ReadonlyArray<PiThinkingLevel> {
  const seen = new Set<PiThinkingLevel>();
  const levels: Array<PiThinkingLevel> = [];
  for (const inputLevel of input) {
    const level = asPiThinkingLevel(inputLevel);
    if (level === undefined || level === "off" || seen.has(level)) continue;
    seen.add(level);
    levels.push(level);
  }
  return levels;
}

function decodeModel(input: unknown): Option.Option<PiDiscoveredModel> {
  return Option.map(decodeOption(OmpModelEntry, input), (model) => {
    const reasoning = model.reasoning === true;
    const efforts = reasoning ? effortLevels(model.thinking?.efforts ?? []) : [];
    const requiresThinking = model.thinking?.requiresEffort === true;
    const thinkingLevels: ReadonlyArray<PiThinkingLevel> =
      efforts.length === 0 || requiresThinking ? efforts : ["off", ...efforts];
    const defaultLevel = asPiThinkingLevel(model.thinking?.defaultLevel);
    const defaultThinkingLevel =
      defaultLevel !== undefined && thinkingLevels.includes(defaultLevel)
        ? defaultLevel
        : undefined;
    return {
      provider: model.provider,
      id: model.id,
      ...(model.name !== undefined ? { name: model.name } : {}),
      reasoning,
      thinkingLevels,
      ...(defaultThinkingLevel !== undefined ? { defaultThinkingLevel } : {}),
      requiresThinking,
      effortMap: effortMappings(model.thinking?.effortMap),
    };
  });
}

function decodeCommandEntry(entry: unknown): Option.Option<PiContextCommand> {
  return Option.map(decodeOption(OmpCommandEntry, entry), (command) => ({
    name: command.name,
    ...(command.description !== undefined ? { description: command.description } : {}),
    source: command.source,
    aliases: command.aliases ?? [],
    ...(command.input?.hint !== undefined ? { inputHint: command.input.hint } : {}),
    subcommands: (command.subcommands ?? []).map((subcommand) => ({
      name: subcommand.name,
      ...(subcommand.description !== undefined ? { description: subcommand.description } : {}),
      ...(subcommand.usage !== undefined ? { usage: subcommand.usage } : {}),
    })),
  }));
}

function decodeCommands(response: RpcResponse | undefined): ReadonlyArray<PiContextCommand> {
  if (!response?.success || response.command !== "get_available_commands") return [];
  return Option.match(decodeOption(CommandsData, response.data), {
    onNone: () => [],
    onSome: ({ commands }) =>
      commands.flatMap((command) => Option.toArray(decodeCommandEntry(command))),
  });
}

export function makeOmpDialectCodec(): PiRpcDialectCodec {
  return {
    kind: "omp",
    listCommandsCommand: { type: "get_available_commands" },
    listRollbackMessagesCommand: { type: "get_branch_messages" },
    makeRollbackCommand: (entryId) => ({ type: "branch", entryId }),
    decodeModel,
    decodeCommands,
    decodeCommandUpdate: (frame: PiControlFrame) =>
      frame.type === "available_commands_update"
        ? Option.some(
            frame.commands.flatMap((command) => Option.toArray(decodeCommandEntry(command))),
          )
        : Option.none(),
    decodeRollbackMessages: (response) =>
      decodeRollbackMessagesFor("get_branch_messages", response),
    decodeSessionState: decodeSessionStateFor,
    decodeSessionStats: decodeSessionStatsFor,
  };
}
