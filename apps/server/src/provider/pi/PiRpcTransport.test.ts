// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";

import { makePiRpcTransport, type PiRpcTransport } from "./PiRpcTransport.ts";

const fixture = String.raw`
import readline from "node:readline";
const rl = readline.createInterface({ input: process.stdin });
const state = { sessionId: "s", thinkingLevel: "medium", isStreaming: false, isCompacting: false, steeringMode: "all", followUpMode: "all", autoCompactionEnabled: true, messageCount: 0, pendingMessageCount: 0 };
let cancellations = 0;
console.log("diagnostic stdout");
for await (const line of rl) {
  const value = JSON.parse(line);
  if (value.type === "extension_ui_response" && value.cancelled === true) {
    cancellations += 1;
    if (cancellations === 3) console.log(JSON.stringify({ type: "response", id: "trigger", command: "get_state", success: true, data: state }));
    continue;
  }
  if (value.id === "bad") console.log(JSON.stringify({ type: "response", id: "bad", command: "get_state", success: true, data: { sessionId: 42 } }));
  if (value.id === "good" || value.id === "after") console.log(JSON.stringify({ type: "response", id: value.id, command: "get_state", success: true, data: state }));
  if (value.id === "release") {
    console.log(JSON.stringify({ type: "response", id: "hold", command: "get_state", success: true, data: state }));
    console.log(JSON.stringify({ type: "response", id: "release", command: "get_state", success: true, data: state }));
  }
  if (value.id === "trigger") {
    for (const method of ["select", "confirm", "input"]) console.log(JSON.stringify({ type: "extension_ui_request", id: "ui-" + method, method }));
  }
  if (value.id === "fatal") console.log(JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "text_delta" } }));
  if (value.id === "exit") process.exit(7);
}
`;

const withTransport = <A, E>(run: (transport: PiRpcTransport) => Effect.Effect<A, E>) =>
  Effect.acquireUseRelease(
    Effect.sync(() => {
      const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "pi-rpc-transport-"));
      const script = NodePath.join(dir, "fixture.mjs");
      NodeFS.writeFileSync(script, fixture, "utf8");
      return { dir, script };
    }),
    ({ script }) =>
      makePiRpcTransport({
        binaryPath: process.execPath,
        args: [script],
        cwd: process.cwd(),
        env: process.env,
        onExit: Effect.void,
      }).pipe(Effect.flatMap(run)),
    ({ dir }) => Effect.sync(() => NodeFS.rmSync(dir, { recursive: true, force: true })),
  );

it.effect("fails only an identifiable malformed pending response", () =>
  withTransport((transport) =>
    Effect.gen(function* () {
      const bad = yield* transport
        .request({ type: "get_state" }, "bad", 2_000)
        .pipe(Effect.exit, Effect.forkChild);
      const good = yield* transport.request({ type: "get_state" }, "good", 2_000);
      assert.equal(good?.command, "get_state");
      assert.isTrue(Exit.isFailure(yield* Fiber.join(bad)));
      const after = yield* transport.request({ type: "get_state" }, "after", 2_000);
      assert.equal(after?.command, "get_state");
    }),
  ).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("cancels malformed identifiable extension UI requests", () =>
  withTransport((transport) =>
    Effect.gen(function* () {
      const response = yield* transport.request({ type: "get_state" }, "trigger", 2_000);
      assert.equal(response?.command, "get_state");
    }),
  ).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("fatal protocol frames fail all requests and future writes", () =>
  withTransport((transport) =>
    Effect.gen(function* () {
      const pending = yield* transport
        .request({ type: "get_state" }, "hold", 2_000)
        .pipe(Effect.exit, Effect.forkChild);
      const fatal = yield* transport
        .request({ type: "get_state" }, "fatal", 2_000)
        .pipe(Effect.exit);
      assert.isTrue(Exit.isFailure(fatal));
      yield* Fiber.join(pending);
      assert.isTrue(
        Exit.isFailure(yield* transport.writeCommand({ type: "abort" }).pipe(Effect.exit)),
      );
    }),
  ).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("interruption unregisters a pending request without closing transport", () =>
  withTransport((transport) =>
    Effect.gen(function* () {
      const pending = yield* transport
        .request({ type: "get_state" }, "hold", 2_000)
        .pipe(Effect.forkChild);
      yield* Fiber.interrupt(pending);
      const good = yield* transport.request({ type: "get_state" }, "good", 2_000);
      assert.equal(good?.command, "get_state");
    }),
  ).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("rejects duplicate request ids without replacing the original request", () =>
  withTransport((transport) =>
    Effect.gen(function* () {
      const original = yield* transport
        .request({ type: "get_state" }, "hold", 2_000)
        .pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      const duplicate = yield* transport
        .request({ type: "get_state" }, "hold", 2_000)
        .pipe(Effect.exit, Effect.forkChild);
      yield* Effect.yieldNow;

      yield* transport.request({ type: "get_state" }, "release", 2_000);

      assert.isTrue(Exit.isFailure(yield* Fiber.join(duplicate)));
      assert.equal((yield* Fiber.join(original))?.command, "get_state");
    }),
  ).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("child exit fails pending requests and future writes", () =>
  withTransport((transport) =>
    Effect.gen(function* () {
      const exited = yield* transport
        .request({ type: "get_state" }, "exit", 2_000)
        .pipe(Effect.exit);
      assert.isTrue(Exit.isFailure(exited));
      assert.isTrue(
        Exit.isFailure(yield* transport.writeCommand({ type: "abort" }).pipe(Effect.exit)),
      );
    }),
  ).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
