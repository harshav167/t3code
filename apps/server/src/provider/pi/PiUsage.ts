import type { TurnId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import type { ProviderAdapterRequestError } from "../Errors.ts";
import type { PiRpcDialectCodec } from "./PiRpcDialect.ts";
import type { PiSessionEvent } from "./PiSessionEvents.ts";
import type { RpcCommand, RpcResponse } from "./PiRpcTypes.ts";

export function refreshPiUsage(options: {
  readonly turnId: TurnId;
  readonly codec: PiRpcDialectCodec;
  readonly request: (
    command: RpcCommand,
    timeout: number,
  ) => Effect.Effect<RpcResponse | undefined, ProviderAdapterRequestError>;
  readonly emit: (event: PiSessionEvent) => Effect.Effect<void>;
}): Effect.Effect<void> {
  return options.request({ type: "get_session_stats" }, 5_000).pipe(
    Effect.flatMap((response) => {
      const stats = Option.getOrUndefined(options.codec.decodeSessionStats(response));
      if (stats === undefined) {
        return options.emit({
          type: "runtime.warning",
          turnId: options.turnId,
          payload: { message: "Pi session statistics were unavailable." },
        });
      }
      const context = stats?.contextUsage;
      if (context === undefined || context.tokens === null) {
        return Effect.void;
      }
      return options.emit({
        type: "thread.token-usage.updated",
        turnId: options.turnId,
        payload: {
          usage: {
            usedTokens: context.tokens,
            ...(stats.tokens.total > context.tokens
              ? { totalProcessedTokens: stats.tokens.total }
              : {}),
            ...(context.contextWindow > 0 ? { maxTokens: context.contextWindow } : {}),
            inputTokens: stats.tokens.input,
            cachedInputTokens: stats.tokens.cacheRead,
            outputTokens: stats.tokens.output,
            ...(stats.tokens.reasoning !== undefined
              ? { reasoningOutputTokens: stats.tokens.reasoning }
              : {}),
            toolUses: stats.toolCalls,
          },
        },
      });
    }),
    Effect.catch((error) =>
      options.emit({
        type: "runtime.warning",
        turnId: options.turnId,
        payload: {
          message: "Pi session statistics could not be refreshed.",
          detail: error.detail,
        },
      }),
    ),
  );
}
