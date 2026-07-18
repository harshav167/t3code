import { describe, expect, it } from "@effect/vitest";
import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import { makePiCommandInventory, makePiServerProvider, piSlashCommands } from "./PiCommands.ts";
import type { PiContextCommand } from "./PiRpcDialect.ts";

const command = (name: string, description?: string): PiContextCommand => ({
  name,
  ...(description !== undefined ? { description } : {}),
  source: "skill",
  aliases: [],
  inputHint: "arguments",
  subcommands: [],
});

describe("Pi commands", () => {
  it("preserves native skill names, filters the approval sentinel, and deduplicates", () => {
    expect(
      piSlashCommands([
        command("skill:review", "Review changes"),
        command("t3-approval-gate"),
        command("skill:review", "Duplicate"),
        command("models", "Choose a model"),
      ]),
    ).toEqual([
      { name: "skill:review", description: "Review changes", input: { hint: "arguments" } },
      { name: "models", description: "Choose a model", input: { hint: "arguments" } },
    ]);
  });

  it.effect("replaces the complete instance inventory with the latest publisher", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const inventory = yield* makePiCommandInventory();
        yield* inventory.replace([command("first")]);
        expect(yield* inventory.get).toEqual([{ name: "first", input: { hint: "arguments" } }]);
        yield* inventory.replace([command("second")]);
        expect(yield* inventory.get).toEqual([{ name: "second", input: { hint: "arguments" } }]);
      }),
    ),
  );

  it.effect("overlays command changes without losing provider snapshot state", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const snapshot: ServerProvider = {
          instanceId: ProviderInstanceId.make("pi_local"),
          driver: ProviderDriverKind.make("pi"),
          enabled: true,
          installed: true,
          version: "0.80.10",
          status: "ready",
          auth: { status: "authenticated", type: "pi" },
          checkedAt: "2026-07-18T00:00:00.000Z",
          models: [],
          slashCommands: [],
          skills: [],
          message: "Ready",
        };
        const inventory = yield* makePiCommandInventory();
        const provider = makePiServerProvider(
          {
            maintenanceCapabilities: {
              provider: ProviderDriverKind.make("pi"),
              packageName: null,
              update: null,
            },
            getSnapshot: Effect.succeed(snapshot),
            refresh: Effect.succeed(snapshot),
            streamChanges: Stream.empty,
          },
          inventory,
        );
        yield* inventory.replace([command("skill:review")]);
        const updated = yield* provider.getSnapshot;
        expect(updated).toEqual({
          ...snapshot,
          slashCommands: [{ name: "skill:review", input: { hint: "arguments" } }],
        });
      }),
    ),
  );
});
