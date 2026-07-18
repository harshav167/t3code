import type { ServerProvider, ServerProviderSlashCommand } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import type { ServerProviderShape } from "../Services/ServerProvider.ts";
import type { PiContextCommand } from "./PiRpcDialect.ts";

const APPROVAL_SENTINEL = "t3-approval-gate";

export function piSlashCommands(
  commands: ReadonlyArray<PiContextCommand>,
): ReadonlyArray<ServerProviderSlashCommand> {
  const seen = new Set<string>();
  const result: Array<ServerProviderSlashCommand> = [];
  for (const command of commands) {
    if (command.name.length === 0 || command.name === APPROVAL_SENTINEL || seen.has(command.name)) {
      continue;
    }
    seen.add(command.name);
    result.push({
      name: command.name,
      ...(command.description !== undefined ? { description: command.description } : {}),
      ...(command.inputHint !== undefined ? { input: { hint: command.inputHint } } : {}),
    });
  }
  return result;
}

export interface PiCommandInventory {
  readonly get: Effect.Effect<ReadonlyArray<ServerProviderSlashCommand>>;
  readonly replace: (
    commands: ReadonlyArray<PiContextCommand>,
  ) => Effect.Effect<ReadonlyArray<ServerProviderSlashCommand>>;
  readonly streamChanges: Stream.Stream<ReadonlyArray<ServerProviderSlashCommand>>;
}

export const makePiCommandInventory = Effect.fn("makePiCommandInventory")(function* () {
  const state = yield* Ref.make<ReadonlyArray<ServerProviderSlashCommand>>([]);
  const changes = yield* Effect.acquireRelease(
    PubSub.unbounded<ReadonlyArray<ServerProviderSlashCommand>>(),
    PubSub.shutdown,
  );

  const replace: PiCommandInventory["replace"] = Effect.fn("PiCommandInventory.replace")(
    function* (commands) {
      const next = piSlashCommands(commands);
      const changed = yield* Ref.modify(state, (current) =>
        Equal.equals(current, next) ? [false, current] : [true, next],
      );
      if (changed) yield* PubSub.publish(changes, next);
      return next;
    },
  );

  return {
    get: Ref.get(state),
    replace,
    streamChanges: Stream.fromPubSub(changes),
  } satisfies PiCommandInventory;
});

function withCommands(
  snapshot: ServerProvider,
  slashCommands: ReadonlyArray<ServerProviderSlashCommand>,
): ServerProvider {
  return { ...snapshot, slashCommands: [...slashCommands] };
}

export function makePiServerProvider(
  provider: ServerProviderShape,
  inventory: PiCommandInventory,
): ServerProviderShape {
  const current = Effect.all([provider.getSnapshot, inventory.get]).pipe(
    Effect.map(([snapshot, commands]) => withCommands(snapshot, commands)),
  );
  const baseChanges = provider.streamChanges.pipe(
    Stream.mapEffect((snapshot) =>
      inventory.get.pipe(Effect.map((commands) => withCommands(snapshot, commands))),
    ),
  );
  const commandChanges = inventory.streamChanges.pipe(
    Stream.mapEffect((commands) =>
      provider.getSnapshot.pipe(Effect.map((snapshot) => withCommands(snapshot, commands))),
    ),
  );
  return {
    maintenanceCapabilities: provider.maintenanceCapabilities,
    getSnapshot: current,
    refresh: provider.refresh.pipe(
      Effect.flatMap((snapshot) =>
        inventory.get.pipe(Effect.map((commands) => withCommands(snapshot, commands))),
      ),
    ),
    streamChanges: Stream.merge(baseChanges, commandChanges),
  };
}
