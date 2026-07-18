import {
  EventId,
  ProviderDriverKind,
  ProviderRuntimeEvent,
  type ProviderInstanceId,
  type ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import type { PiSessionEvent } from "./PiSessionEvents.ts";

const decodeProviderRuntimeEvent = Schema.decodeUnknownEffect(ProviderRuntimeEvent);

export function makePiSessionEmitter(options: {
  readonly instanceId: ProviderInstanceId;
  readonly threadId: ThreadId;
  readonly nextUuid: Effect.Effect<string>;
  readonly now: Effect.Effect<string>;
  readonly emit: (event: ProviderRuntimeEvent) => Effect.Effect<void>;
}): (event: PiSessionEvent) => Effect.Effect<void> {
  return (event) =>
    Effect.all({
      eventId: options.nextUuid.pipe(Effect.map(EventId.make)),
      createdAt: options.now,
    }).pipe(
      Effect.flatMap((stamp) =>
        decodeProviderRuntimeEvent({
          ...event,
          ...stamp,
          provider: ProviderDriverKind.make("pi"),
          providerInstanceId: options.instanceId,
          threadId: options.threadId,
        }).pipe(Effect.orDie, Effect.flatMap(options.emit)),
      ),
    );
}
