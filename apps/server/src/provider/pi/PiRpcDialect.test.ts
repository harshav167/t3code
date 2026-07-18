import { describe, expect, it } from "@effect/vitest";
import * as Option from "effect/Option";

import { makeOmpDialectCodec } from "./PiRpcOmpDialect.ts";
import { makePiDialectCodec } from "./PiRpcPiDialect.ts";
import { decodeAvailableModels } from "./PiRpcDialect.ts";
import type { PiControlFrame, RpcResponse } from "./PiRpcTypes.ts";

function response(input: {
  readonly command: string;
  readonly success?: boolean;
  readonly data?: unknown;
}): RpcResponse {
  return {
    type: "response",
    id: "request-1",
    command: input.command,
    success: input.success ?? true,
    ...(input.data !== undefined ? { data: input.data } : {}),
  };
}

describe("Pi RPC dialects", () => {
  it("normalizes Pi thinkingLevelMap without inventing high effort tiers", () => {
    const model = Option.getOrThrow(
      makePiDialectCodec().decodeModel({
        provider: "openai-codex",
        id: "gpt-5.6-sol",
        name: "GPT 5.6 Sol",
        reasoning: true,
        thinkingLevelMap: {
          minimal: null,
          low: null,
          medium: "medium",
          high: "high",
          xhigh: "xhigh",
          max: "max",
        },
      }),
    );
    expect(model).toEqual({
      provider: "openai-codex",
      id: "gpt-5.6-sol",
      name: "GPT 5.6 Sol",
      reasoning: true,
      thinkingLevels: ["off", "medium", "high", "xhigh", "max"],
      defaultThinkingLevel: "medium",
      requiresThinking: false,
      effortMap: [
        { level: "medium", value: "medium" },
        { level: "high", value: "high" },
        { level: "xhigh", value: "xhigh" },
        { level: "max", value: "max" },
      ],
    });
    expect(
      Option.getOrThrow(
        makePiDialectCodec().decodeModel({
          provider: "openai-codex",
          id: "gpt-5.6-terra",
          reasoning: true,
          thinkingLevelMap: { low: "low", medium: "medium", high: "high" },
        }),
      ).thinkingLevels,
    ).toEqual(["off", "minimal", "low", "medium", "high"]);
  });

  it("normalizes OMP ordered efforts, default, effortMap, and mandatory thinking", () => {
    const model = Option.getOrThrow(
      makeOmpDialectCodec().decodeModel({
        provider: "openai-codex",
        id: "gpt-5.6-luna",
        reasoning: true,
        thinking: {
          efforts: ["low", "medium", "high", "xhigh", "max"],
          defaultLevel: "high",
          effortMap: { low: "low", max: "xhigh" },
          requiresEffort: true,
        },
      }),
    );
    expect(model.thinkingLevels).toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(model.defaultThinkingLevel).toBe("high");
    expect(model.requiresThinking).toBe(true);
    expect(model.effortMap).toEqual([
      { level: "low", value: "low" },
      { level: "max", value: "xhigh" },
    ]);
  });

  it("keeps off for optional OMP thinking and hides an empty selector", () => {
    const codec = makeOmpDialectCodec();
    expect(
      Option.getOrThrow(
        codec.decodeModel({
          provider: "openai-codex",
          id: "gpt-5.6-sol",
          reasoning: true,
          thinking: { efforts: ["medium", "high"], defaultLevel: "medium" },
        }),
      ).thinkingLevels,
    ).toEqual(["off", "medium", "high"]);
    expect(
      Option.getOrThrow(
        codec.decodeModel({
          provider: "devin",
          id: "devin-agent",
          reasoning: true,
          thinking: { efforts: [] },
        }),
      ).thinkingLevels,
    ).toEqual([]);
  });

  it("decodes Pi and OMP command inventories into one normalized shape", () => {
    const pi = makePiDialectCodec().decodeCommands(
      response({
        command: "get_commands",
        data: {
          commands: [
            {
              name: "skill:review",
              description: "Review changes",
              source: "skill",
              sourceInfo: { path: "/repo/.pi/skills/review/SKILL.md", scope: "project" },
            },
          ],
        },
      }),
    );
    expect(pi[0]).toMatchObject({
      name: "skill:review",
      source: "skill",
      path: "/repo/.pi/skills/review/SKILL.md",
      scope: "project",
    });

    const omp = makeOmpDialectCodec().decodeCommands(
      response({
        command: "get_available_commands",
        data: {
          commands: [
            {
              name: "models",
              aliases: ["model"],
              description: "Choose a model",
              input: { hint: "model name" },
              subcommands: [{ name: "list", usage: "/models list" }],
              source: "builtin",
            },
          ],
        },
      }),
    );
    expect(omp[0]).toEqual({
      name: "models",
      aliases: ["model"],
      description: "Choose a model",
      inputHint: "model name",
      subcommands: [{ name: "list", usage: "/models list" }],
      source: "builtin",
    });
  });

  it("decodes OMP command updates but not Pi updates", () => {
    const frame: PiControlFrame = {
      type: "available_commands_update",
      commands: [{ name: "skill:review", source: "skill" }],
    };
    expect(Option.isNone(makePiDialectCodec().decodeCommandUpdate(frame))).toBe(true);
    expect(Option.getOrThrow(makeOmpDialectCodec().decodeCommandUpdate(frame))[0]?.name).toBe(
      "skill:review",
    );
  });

  it("decodes models, state, rollback messages, and token statistics", () => {
    const codec = makeOmpDialectCodec();
    expect(
      decodeAvailableModels(
        codec,
        response({
          command: "get_available_models",
          data: { models: [{ provider: "openai", id: "gpt", reasoning: false }] },
        }),
      ),
    ).toHaveLength(1);
    expect(
      Option.getOrThrow(
        codec.decodeSessionState(
          response({
            command: "get_state",
            data: { sessionId: "session", queuedMessageCount: 2 },
          }),
        ),
      ),
    ).toEqual({ sessionId: "session", queuedCount: 2 });
    expect(
      codec.decodeRollbackMessages(
        response({
          command: "get_branch_messages",
          data: { messages: [{ entryId: "entry-1", text: "hello" }] },
        }),
      ),
    ).toEqual([{ entryId: "entry-1", text: "hello" }]);
    expect(
      Option.getOrThrow(
        codec.decodeSessionStats(
          response({
            command: "get_session_stats",
            data: {
              toolCalls: 3,
              tokens: {
                input: 10,
                output: 5,
                reasoning: 2,
                cacheRead: 4,
                cacheWrite: 1,
                total: 22,
              },
              contextUsage: { tokens: 20, contextWindow: 200_000, percent: 0.01 },
            },
          }),
        ),
      ).contextUsage,
    ).toEqual({ tokens: 20, contextWindow: 200_000, percent: 0.01 });
  });
});
