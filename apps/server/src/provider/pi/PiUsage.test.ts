import { ProviderDriverKind, TurnId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { ProviderAdapterRequestError } from "../Errors.ts";
import { makePiDialectCodec } from "./PiRpcPiDialect.ts";
import type { PiSessionEvent } from "./PiSessionEvents.ts";
import { refreshPiUsage } from "./PiUsage.ts";

describe("Pi usage", () => {
  it.effect("emits complete token and context-window usage", () =>
    Effect.gen(function* () {
      const events: Array<PiSessionEvent> = [];
      yield* refreshPiUsage({
        turnId: TurnId.make("turn-usage"),
        codec: makePiDialectCodec(),
        request: () =>
          Effect.succeed({
            type: "response",
            id: "stats-1",
            command: "get_session_stats",
            success: true,
            data: {
              toolCalls: 4,
              tokens: {
                input: 120,
                output: 30,
                reasoning: 8,
                cacheRead: 50,
                cacheWrite: 2,
                total: 210,
              },
              contextUsage: { tokens: 180, contextWindow: 200_000, percent: 0.09 },
            },
          }),
        emit: (event) => Effect.sync(() => events.push(event)).pipe(Effect.asVoid),
      });
      expect(events).toEqual([
        {
          type: "thread.token-usage.updated",
          turnId: "turn-usage",
          payload: {
            usage: {
              usedTokens: 180,
              totalProcessedTokens: 210,
              maxTokens: 200_000,
              inputTokens: 120,
              cachedInputTokens: 50,
              outputTokens: 30,
              reasoningOutputTokens: 8,
              toolUses: 4,
            },
          },
        },
      ]);
    }),
  );

  it.effect("does not fabricate unknown context usage and warns on request failure", () =>
    Effect.gen(function* () {
      const events: Array<PiSessionEvent> = [];
      const base = {
        turnId: TurnId.make("turn-usage"),
        codec: makePiDialectCodec(),
        emit: (event: PiSessionEvent) => Effect.sync(() => events.push(event)).pipe(Effect.asVoid),
      };
      yield* refreshPiUsage({
        ...base,
        request: () =>
          Effect.succeed({
            type: "response",
            id: "stats-null",
            command: "get_session_stats",
            success: true,
            data: {
              toolCalls: 0,
              tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
              contextUsage: { tokens: null, contextWindow: 200_000 },
            },
          }),
      });
      expect(events).toEqual([]);
      yield* refreshPiUsage({
        ...base,
        request: () =>
          Effect.fail(
            new ProviderAdapterRequestError({
              provider: ProviderDriverKind.make("pi"),
              method: "get_session_stats",
              detail: "timed out",
            }),
          ),
      });
      expect(events[0]).toMatchObject({
        type: "runtime.warning",
        payload: { message: "Pi session statistics could not be refreshed.", detail: "timed out" },
      });
    }),
  );
});
