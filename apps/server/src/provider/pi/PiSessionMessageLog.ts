import { ProviderDriverKind, type ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import type { EventNdjsonLogger } from "../Layers/EventNdjsonLogger.ts";
import type { PiStdoutMessage } from "./PiRpcProtocol.ts";

export function logPiSessionMessage(options: {
  readonly logger: EventNdjsonLogger | undefined;
  readonly message: PiStdoutMessage;
  readonly threadId: ThreadId;
  readonly now: Effect.Effect<string>;
}): Effect.Effect<void> {
  if (options.logger === undefined) return Effect.void;
  return options.now.pipe(
    Effect.flatMap(
      (observedAt) =>
        options.logger?.write(
          {
            observedAt,
            provider: ProviderDriverKind.make("pi"),
            threadId: options.threadId,
            message: options.message,
          },
          options.threadId,
        ) ?? Effect.void,
    ),
  );
}
