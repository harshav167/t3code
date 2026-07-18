import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import {
  ApprovalRequestId,
  PiSettings,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderRuntimeEvent,
  ThreadId,
} from "@t3tools/contracts";
import { ServerConfig } from "../../config.ts";
import { makePiAdapter } from "../Layers/PiAdapter.ts";
import type { PiAdapterShape } from "../Services/PiAdapter.ts";
import type {
  AgentSessionEvent,
  PiControlFrame,
  PiStdoutMessage,
  RpcExtensionUIRequest,
  RpcExtensionUIResponse,
  RpcResponse,
} from "./PiRpcProtocol.ts";
import type { RpcCommand } from "./PiModels.ts";
import {
  type MakePiRpcTransportOptions,
  type PiRpcTransport,
  PiRpcTransportError,
} from "./PiRpcTransport.ts";

const decodeSettings = Schema.decodeSync(PiSettings);
const PI = ProviderDriverKind.make("pi");
const TestLayer = ServerConfig.layerTest(process.cwd(), { prefix: "pi-session-test-" }).pipe(
  Layer.provideMerge(NodeServices.layer),
);
const asResponse = (value: unknown): RpcResponse => value as RpcResponse;

interface PiSessionHarness {
  readonly adapter: PiAdapterShape;
  readonly commands: RpcCommand[];
  readonly requests: RpcCommand[];
  readonly requestIds: Array<{ readonly command: RpcCommand["type"]; readonly id: string }>;
  readonly extensionResponses: RpcExtensionUIResponse[];
  readonly responses: Map<string, RpcResponse | undefined>;
  readonly events: ProviderRuntimeEvent[];
  readonly exit: () => Effect.Effect<void>;
  readonly scopeClosed: () => boolean;
  readonly setRequestDelay: (command: RpcCommand["type"], milliseconds: number) => void;
  readonly setWriteFailure: (value: boolean) => void;
  readonly pushEvent: (event: AgentSessionEvent) => Effect.Effect<void>;
  readonly pushControl: (frame: PiControlFrame) => Effect.Effect<void>;
  readonly pushExtension: (request: RpcExtensionUIRequest) => Effect.Effect<void>;
  readonly waitFor: (predicate: () => boolean) => Effect.Effect<void>;
}

const makeHarness = Effect.gen(function* () {
  const messages = yield* Queue.unbounded<PiStdoutMessage>();
  const commands: RpcCommand[] = [];
  const requests: RpcCommand[] = [];
  const requestIds: Array<{ readonly command: RpcCommand["type"]; readonly id: string }> = [];
  const extensionResponses: RpcExtensionUIResponse[] = [];
  const responses = new Map<string, RpcResponse | undefined>();
  const requestDelays = new Map<RpcCommand["type"], number>();
  responses.set(
    "get_state",
    asResponse({
      type: "response",
      command: "get_state",
      success: true,
      data: { sessionFile: "/tmp/pi-original.json" },
    }),
  );
  responses.set(
    "get_commands",
    asResponse({
      type: "response",
      command: "get_commands",
      success: true,
      data: { commands: [{ name: "t3-approval-gate" }] },
    }),
  );
  for (const command of ["prompt", "steer", "abort"] as const) {
    responses.set(command, asResponse({ type: "response", command, success: true }));
  }
  let exit = Effect.void;
  let writeFailure = false;
  let scopeClosed = false;
  const transport: PiRpcTransport = {
    writeCommand: (command) =>
      writeFailure
        ? Effect.fail(new PiRpcTransportError({ detail: "write failed" }))
        : Effect.sync(() => commands.push(command)).pipe(Effect.asVoid),
    writeExtensionResponse: (response) =>
      writeFailure
        ? Effect.fail(new PiRpcTransportError({ detail: "write failed" }))
        : Effect.sync(() => extensionResponses.push(response)).pipe(Effect.asVoid),
    request: (command, id, timeoutMs) => {
      if (writeFailure) return Effect.fail(new PiRpcTransportError({ detail: "write failed" }));
      requests.push(command);
      requestIds.push({ command: command.type, id });
      const response = Effect.sleep(requestDelays.get(command.type) ?? 0).pipe(
        Effect.andThen(Effect.sync(() => responses.get(command.type))),
      );
      return response.pipe(Effect.timeoutOption(timeoutMs), Effect.map(Option.getOrUndefined));
    },
    messages,
    kill: Effect.void,
  };
  const adapter = yield* makePiAdapter(decodeSettings({ enabled: true }), {
    makeTransport: (options: MakePiRpcTransportOptions) =>
      Effect.gen(function* () {
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            scopeClosed = true;
          }),
        );
        exit = options.onExit;
        return transport;
      }),
  });
  const events: ProviderRuntimeEvent[] = [];
  yield* adapter.streamEvents.pipe(
    Stream.runForEach((event) => Effect.sync(() => events.push(event))),
    Effect.forkChild,
  );

  const waitFor = (predicate: () => boolean): Effect.Effect<void> =>
    Effect.gen(function* () {
      for (let attempt = 0; attempt < 100; attempt += 1) {
        if (predicate()) return;
        yield* Effect.yieldNow;
      }
      return yield* Effect.die(new Error("Timed out waiting for Pi session condition."));
    });
  return {
    adapter,
    commands,
    requests,
    requestIds,
    extensionResponses,
    responses,
    events,
    exit: () => exit,
    scopeClosed: () => scopeClosed,
    setRequestDelay: (command, milliseconds) => {
      requestDelays.set(command, milliseconds);
    },
    setWriteFailure: (value) => {
      writeFailure = value;
    },
    pushEvent: (event: AgentSessionEvent) =>
      Queue.offer(messages, { _tag: "event", event }).pipe(Effect.asVoid),
    pushControl: (frame: PiControlFrame) =>
      Queue.offer(messages, { _tag: "control", frame }).pipe(Effect.asVoid),
    pushExtension: (request: RpcExtensionUIRequest) =>
      Queue.offer(messages, { _tag: "extension-ui", request }).pipe(Effect.asVoid),
    waitFor,
  } satisfies PiSessionHarness;
});

const start = (
  harness: PiSessionHarness,
  threadId: ThreadId,
  runtimeMode: "full-access" | "approval-required" = "full-access",
) =>
  harness.adapter.startSession({
    threadId,
    provider: PI,
    cwd: process.cwd(),
    runtimeMode,
  });

it.layer(TestLayer)("PiSession lifecycle", (it) => {
  it.effect("closes the transport scope when post-spawn initialization fails", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      harness.setWriteFailure(true);

      const started = yield* start(harness, ThreadId.make("pi-startup-failure")).pipe(Effect.exit);

      expect(Exit.isFailure(started)).toBe(true);
      expect(harness.scopeClosed()).toBe(true);
    }),
  );

  it.effect("settles pending approval and input exactly once on interrupt and agent_end", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      const threadId = ThreadId.make("pi-settlement-interrupt");
      yield* start(harness, threadId);
      yield* harness.adapter.sendTurn({ threadId, input: "run", attachments: [] });
      yield* harness.pushExtension({
        type: "extension_ui_request",
        id: "approval-1",
        method: "confirm",
        title: "bash",
        message: "run",
      });
      yield* harness.pushExtension({
        type: "extension_ui_request",
        id: "input-1",
        method: "input",
        title: "Name",
      });
      yield* harness.waitFor(
        () =>
          harness.events.filter(
            ({ type }) => type === "request.opened" || type === "user-input.requested",
          ).length === 2,
      );

      yield* harness.adapter.interruptTurn(threadId);
      yield* harness.pushEvent({
        type: "agent_end",
        messages: [],
        willRetry: false,
      } as AgentSessionEvent);
      yield* harness.waitFor(
        () =>
          harness.events.filter(
            ({ type }) => type === "request.resolved" || type === "user-input.resolved",
          ).length === 2,
      );

      expect(harness.extensionResponses).toEqual(
        expect.arrayContaining([
          { type: "extension_ui_response", id: "approval-1", cancelled: true },
          { type: "extension_ui_response", id: "input-1", cancelled: true },
        ]),
      );
      expect(harness.extensionResponses).toHaveLength(2);
      const approval = harness.events.find((event) => event.type === "request.resolved");
      const input = harness.events.find((event) => event.type === "user-input.resolved");
      expect(approval?.type === "request.resolved" ? approval.payload.decision : undefined).toBe(
        "cancel",
      );
      expect(input?.type === "user-input.resolved" ? input.payload.answers : undefined).toEqual({});
    }),
  );

  it.effect("settles pending requests exactly once when the child exits", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      const threadId = ThreadId.make("pi-settlement-exit");
      yield* start(harness, threadId);
      yield* harness.pushExtension({
        type: "extension_ui_request",
        id: "approval-exit",
        method: "confirm",
        title: "bash",
        message: "run",
      });
      yield* harness.waitFor(() => harness.events.some(({ type }) => type === "request.opened"));
      yield* harness.exit();
      yield* harness.waitFor(() => harness.events.some(({ type }) => type === "session.exited"));
      yield* harness.exit();
      expect(
        harness.extensionResponses.filter(
          (response) => response.id === "approval-exit" && "cancelled" in response,
        ),
      ).toHaveLength(1);
      expect(yield* harness.adapter.hasSession(threadId)).toBe(false);
    }),
  );

  it.effect("keeps pre-commit rollback failures transactional", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      const threadId = ThreadId.make("pi-rollback-transaction");
      yield* start(harness, threadId);
      for (const input of ["one", "two"]) {
        yield* harness.adapter.sendTurn({ threadId, input, attachments: [] });
        yield* harness.pushEvent({
          type: "agent_end",
          messages: [],
          willRetry: false,
        } as AgentSessionEvent);
        yield* harness.waitFor(
          () =>
            harness.events.filter(({ type }) => type === "turn.completed").length >=
            (input === "one" ? 1 : 2),
        );
      }
      harness.responses.set(
        "get_fork_messages",
        asResponse({
          type: "response",
          command: "get_fork_messages",
          success: true,
          data: {
            messages: [
              { entryId: "one", text: "one" },
              { entryId: "two", text: "two" },
            ],
          },
        }),
      );
      harness.responses.set(
        "fork",
        asResponse({ type: "response", command: "fork", success: false, error: "no" }),
      );

      expect((yield* harness.adapter.rollbackThread(threadId, 1).pipe(Effect.result))._tag).toBe(
        "Failure",
      );
      expect((yield* harness.adapter.readThread(threadId)).turns).toHaveLength(2);
      expect(harness.requests.some(({ type }) => type === "abort")).toBe(false);
    }),
  );

  it.effect("commits native rollback once and refreshes the resume cursor", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      const threadId = ThreadId.make("pi-rollback-commit");
      yield* start(harness, threadId);
      yield* harness.adapter.sendTurn({ threadId, input: "one", attachments: [] });
      yield* harness.pushEvent({
        type: "agent_end",
        messages: [],
        willRetry: false,
      } as AgentSessionEvent);
      yield* harness.waitFor(() => harness.events.some(({ type }) => type === "turn.completed"));
      harness.responses.set(
        "get_fork_messages",
        asResponse({
          type: "response",
          command: "get_fork_messages",
          success: true,
          data: { messages: [{ entryId: "one", text: "one" }] },
        }),
      );
      harness.responses.set(
        "new_session",
        asResponse({
          type: "response",
          command: "new_session",
          success: true,
          data: { cancelled: false },
        }),
      );
      harness.responses.set(
        "get_state",
        asResponse({
          type: "response",
          command: "get_state",
          success: true,
          data: { sessionFile: "/tmp/pi-replaced.json" },
        }),
      );
      yield* harness.pushExtension({
        type: "extension_ui_request",
        id: "approval-new-session",
        method: "confirm",
        title: "bash",
        message: "run",
      });
      yield* harness.pushExtension({
        type: "extension_ui_request",
        id: "input-new-session",
        method: "input",
        title: "Name",
      });
      yield* harness.waitFor(
        () =>
          harness.events.filter(
            ({ type }) => type === "request.opened" || type === "user-input.requested",
          ).length === 2,
      );

      const snapshot = yield* harness.adapter.rollbackThread(threadId, 1);
      expect(snapshot.turns).toEqual([]);
      yield* harness.waitFor(
        () =>
          harness.events.filter(
            ({ type }) => type === "request.resolved" || type === "user-input.resolved",
          ).length === 2,
      );
      expect(harness.extensionResponses).toEqual(
        expect.arrayContaining([
          { type: "extension_ui_response", id: "approval-new-session", cancelled: true },
          { type: "extension_ui_response", id: "input-new-session", cancelled: true },
        ]),
      );
      const sessions = yield* harness.adapter.listSessions();
      expect(sessions[0]?.resumeCursor).toEqual({ sessionFile: "/tmp/pi-replaced.json" });
      yield* harness.waitFor(() =>
        harness.events.some(
          (event) =>
            event.type === "thread.started" &&
            event.payload.providerThreadId === "/tmp/pi-replaced.json",
        ),
      );
      expect(
        harness.events.some(
          (event) =>
            event.type === "thread.started" &&
            event.payload.providerThreadId === "/tmp/pi-replaced.json",
        ),
      ).toBe(true);
    }),
  );

  it.effect("stops an unresumable session after the native rollback commit", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      const threadId = ThreadId.make("pi-rollback-unresumable");
      yield* start(harness, threadId);
      yield* harness.adapter.sendTurn({ threadId, input: "one", attachments: [] });
      yield* harness.pushEvent({
        type: "agent_end",
        messages: [],
        willRetry: false,
      } as AgentSessionEvent);
      yield* harness.waitFor(() => harness.events.some(({ type }) => type === "turn.completed"));
      harness.responses.set(
        "get_fork_messages",
        asResponse({
          type: "response",
          command: "get_fork_messages",
          success: true,
          data: { messages: [{ entryId: "one", text: "one" }] },
        }),
      );
      harness.responses.set(
        "new_session",
        asResponse({
          type: "response",
          command: "new_session",
          success: true,
          data: { cancelled: false },
        }),
      );
      harness.responses.set("get_state", undefined);

      const snapshot = yield* harness.adapter.rollbackThread(threadId, 1);
      expect(snapshot.turns).toEqual([]);
      expect(yield* harness.adapter.hasSession(threadId)).toBe(false);
      yield* harness.waitFor(() => harness.events.some(({ type }) => type === "session.exited"));
      expect(harness.events.some(({ type }) => type === "session.exited")).toBe(true);
    }),
  );

  it.effect("records a failed turn when the prompt write fails", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      const threadId = ThreadId.make("pi-write-failure");
      yield* start(harness, threadId);
      harness.setWriteFailure(true);

      const result = yield* harness.adapter
        .sendTurn({ threadId, input: "will fail", attachments: [] })
        .pipe(Effect.result);
      yield* harness.waitFor(() => harness.events.some((event) => event.type === "turn.completed"));
      expect(result._tag).toBe("Failure");
      expect((yield* harness.adapter.readThread(threadId)).turns).toHaveLength(1);
      expect(harness.events.some(({ type }) => type === "turn.started")).toBe(true);
      expect(
        harness.events.some(
          (event) => event.type === "turn.completed" && event.payload.state === "failed",
        ),
      ).toBe(true);
      expect((yield* harness.adapter.listSessions())[0]?.status).toBe("ready");
    }),
  );

  it.effect("waits for prompt preflight beyond the request timeout used by other commands", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      const threadId = ThreadId.make("pi-slow-prompt-preflight");
      yield* start(harness, threadId);
      harness.setRequestDelay("prompt", 6_000);
      const pending = yield* harness.adapter
        .sendTurn({ threadId, input: "wait for preflight", attachments: [] })
        .pipe(Effect.forkChild);

      yield* Effect.yieldNow;
      yield* TestClock.adjust("6 seconds");

      expect((yield* Fiber.join(pending)).threadId).toBe(threadId);
      expect(harness.events.some(({ type }) => type === "turn.started")).toBe(true);
    }),
  );

  it.effect("services extension UI while prompt preflight is pending", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      const threadId = ThreadId.make("pi-preflight-extension-ui");
      yield* start(harness, threadId);
      harness.setRequestDelay("prompt", 6_000);
      const pending = yield* harness.adapter
        .sendTurn({ threadId, input: "run extension", attachments: [] })
        .pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      yield* harness.pushExtension({
        type: "extension_ui_request",
        id: "preflight-confirm",
        method: "confirm",
        title: "Allow extension",
        message: "Continue prompt preflight?",
      });
      yield* harness.waitFor(() => harness.events.some((event) => event.type === "request.opened"));
      const opened = harness.events.find((event) => event.type === "request.opened");

      yield* harness.adapter.respondToRequest(
        threadId,
        ApprovalRequestId.make(String(opened?.requestId)),
        "accept",
      );
      yield* TestClock.adjust("6 seconds");

      expect((yield* Fiber.join(pending)).threadId).toBe(threadId);
      expect(harness.extensionResponses).toContainEqual({
        type: "extension_ui_response",
        id: "preflight-confirm",
        confirmed: true,
      });
    }),
  );

  it.effect("stops the session when prompt preflight exceeds its safety bound", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      const threadId = ThreadId.make("pi-stuck-prompt-preflight");
      yield* start(harness, threadId);
      harness.setRequestDelay("prompt", 6 * 60_000);
      const pending = yield* harness.adapter
        .sendTurn({ threadId, input: "stuck preflight", attachments: [] })
        .pipe(Effect.result, Effect.forkChild);

      yield* Effect.yieldNow;
      yield* TestClock.adjust("6 minutes");

      expect((yield* Fiber.join(pending))._tag).toBe("Failure");
      expect(yield* harness.adapter.hasSession(threadId)).toBe(false);
    }),
  );

  it.effect("completes an OMP local-only prompt from the correlated response", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      const threadId = ThreadId.make("omp-local-response");
      harness.responses.set(
        "prompt",
        asResponse({
          type: "response",
          command: "prompt",
          success: true,
          data: { agentInvoked: false },
        }),
      );
      yield* start(harness, threadId);

      yield* harness.adapter.sendTurn({ threadId, input: "/status", attachments: [] });
      yield* harness.waitFor(() => harness.events.some((event) => event.type === "turn.completed"));

      expect((yield* harness.adapter.listSessions())[0]?.status).toBe("ready");
    }),
  );

  it.effect("surfaces OMP command output and completes on a local-only prompt result", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      const threadId = ThreadId.make("omp-local-control");
      yield* start(harness, threadId);
      yield* harness.adapter.sendTurn({ threadId, input: "/status", attachments: [] });
      const promptRequestId = harness.requestIds.find(({ command }) => command === "prompt")?.id;
      if (!promptRequestId)
        return yield* Effect.die(new Error("Prompt request id was not recorded."));

      yield* harness.pushControl({ type: "command_output", text: "Local status\n" });
      yield* harness.pushControl({
        type: "prompt_result",
        id: "stale-prompt",
        agentInvoked: false,
      });
      yield* harness.pushControl({ type: "command_output", text: "Still active\n" });
      yield* harness.waitFor(() =>
        harness.events.some(
          (event) => event.type === "content.delta" && event.payload.delta === "Still active\n",
        ),
      );
      expect(harness.events.some((event) => event.type === "turn.completed")).toBe(false);
      yield* harness.pushControl({
        type: "prompt_result",
        id: promptRequestId,
        agentInvoked: false,
      });
      yield* harness.waitFor(() => harness.events.some((event) => event.type === "turn.completed"));

      expect(
        harness.events.some(
          (event) =>
            event.type === "content.delta" &&
            event.payload.streamKind === "command_output" &&
            event.payload.delta === "Local status\n",
        ),
      ).toBe(true);
    }),
  );

  it.effect("does not mutate turn state when model configuration fails", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      const threadId = ThreadId.make("pi-config-failure");
      yield* start(harness, threadId);
      harness.responses.set(
        "set_model",
        asResponse({ type: "response", command: "set_model", success: false, error: "no" }),
      );

      const result = yield* harness.adapter
        .sendTurn({
          threadId,
          input: "will not start",
          attachments: [],
          modelSelection: {
            instanceId: ProviderInstanceId.make("pi"),
            model: "openai/gpt-5",
          },
        })
        .pipe(Effect.result);
      expect(result._tag).toBe("Failure");
      expect((yield* harness.adapter.readThread(threadId)).turns).toEqual([]);
      expect(harness.commands).toEqual([]);
      expect(harness.events.some(({ type }) => type === "turn.started")).toBe(false);
    }),
  );

  it.effect("serializes concurrent sends into one prompt followed by steering", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      const threadId = ThreadId.make("pi-concurrent-send");
      yield* start(harness, threadId);

      const [first, second] = yield* Effect.all(
        [
          harness.adapter.sendTurn({ threadId, input: "first", attachments: [] }),
          harness.adapter.sendTurn({ threadId, input: "second", attachments: [] }),
        ],
        { concurrency: "unbounded" },
      );
      expect(second.turnId).toBe(first.turnId);
      expect(
        harness.requests
          .map(({ type }) => type)
          .filter((type) => type === "prompt" || type === "steer"),
      ).toEqual(["prompt", "steer"]);
      yield* harness.waitFor(
        () => harness.events.filter(({ type }) => type === "turn.started").length === 1,
      );
      expect(harness.events.filter(({ type }) => type === "turn.started")).toHaveLength(1);
    }),
  );

  it.effect("settles pending requests exactly once when stopped", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      const threadId = ThreadId.make("pi-settlement-stop");
      yield* start(harness, threadId);
      yield* harness.pushExtension({
        type: "extension_ui_request",
        id: "approval-stop",
        method: "confirm",
        title: "bash",
        message: "run",
      });
      yield* harness.pushExtension({
        type: "extension_ui_request",
        id: "input-stop",
        method: "input",
        title: "Name",
      });
      yield* harness.waitFor(
        () =>
          harness.events.filter(
            ({ type }) => type === "request.opened" || type === "user-input.requested",
          ).length === 2,
      );

      yield* harness.adapter.stopSession(threadId);
      yield* harness.waitFor(
        () =>
          harness.events.filter(
            ({ type }) => type === "request.resolved" || type === "user-input.resolved",
          ).length === 2,
      );
      expect(harness.extensionResponses).toEqual(
        expect.arrayContaining([
          { type: "extension_ui_response", id: "approval-stop", cancelled: true },
          { type: "extension_ui_response", id: "input-stop", cancelled: true },
        ]),
      );
      expect(
        harness.events.filter(
          ({ type }) => type === "request.resolved" || type === "user-input.resolved",
        ),
      ).toHaveLength(2);
    }),
  );

  it.effect("rejects an operation captured before the session stops", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      const threadId = ThreadId.make("pi-lazy-closed-guard");
      yield* start(harness, threadId);
      const queuedRead = harness.adapter.readThread(threadId);

      yield* harness.adapter.stopSession(threadId);

      expect(Exit.isFailure(yield* queuedRead.pipe(Effect.exit))).toBe(true);
    }),
  );

  it.effect("retains pending approval and input when response delivery fails", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      const threadId = ThreadId.make("pi-pending-delivery-failure");
      yield* start(harness, threadId);
      yield* harness.pushExtension({
        type: "extension_ui_request",
        id: "approval-delivery",
        method: "confirm",
        title: "bash",
        message: "run",
      });
      yield* harness.pushExtension({
        type: "extension_ui_request",
        id: "input-delivery",
        method: "input",
        title: "Name",
      });
      yield* harness.waitFor(
        () =>
          harness.events.filter(
            ({ type }) => type === "request.opened" || type === "user-input.requested",
          ).length === 2,
      );
      const approval = harness.events.find((event) => event.type === "request.opened");
      const input = harness.events.find((event) => event.type === "user-input.requested");
      const approvalId = ApprovalRequestId.make(String(approval?.requestId));
      const inputId = ApprovalRequestId.make(String(input?.requestId));
      harness.setWriteFailure(true);

      expect(
        Exit.isFailure(
          yield* harness.adapter.respondToRequest(threadId, approvalId, "accept").pipe(Effect.exit),
        ),
      ).toBe(true);
      expect(
        Exit.isFailure(
          yield* harness.adapter
            .respondToUserInput(threadId, inputId, { [String(inputId)]: "Harsha" })
            .pipe(Effect.exit),
        ),
      ).toBe(true);

      harness.setWriteFailure(false);
      yield* harness.adapter.respondToRequest(threadId, approvalId, "accept");
      yield* harness.adapter.respondToUserInput(threadId, inputId, {
        [String(inputId)]: "Harsha",
      });
    }),
  );

  it.effect("opens a request when cached approval delivery fails", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      const threadId = ThreadId.make("pi-cached-approval-failure");
      yield* start(harness, threadId);
      const confirm = (id: string): RpcExtensionUIRequest => ({
        type: "extension_ui_request",
        id,
        method: "confirm",
        title: "bash",
        message: "printf ok",
      });
      yield* harness.pushExtension(confirm("approval-initial"));
      yield* harness.waitFor(
        () => harness.events.filter(({ type }) => type === "request.opened").length === 1,
      );
      const opened = harness.events.find((event) => event.type === "request.opened");
      yield* harness.adapter.respondToRequest(
        threadId,
        ApprovalRequestId.make(String(opened?.requestId)),
        "acceptForSession",
      );
      harness.setWriteFailure(true);

      yield* harness.pushExtension(confirm("approval-cached-failure"));
      yield* harness.waitFor(
        () => harness.events.filter(({ type }) => type === "request.opened").length === 2,
      );
    }),
  );

  it.effect("emits final tool output once for streamed and end-only results", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      const threadId = ThreadId.make("pi-tool-final-results");
      yield* start(harness, threadId);
      yield* harness.adapter.sendTurn({ threadId, input: "run", attachments: [] });
      yield* harness.pushEvent({
        type: "tool_execution_start",
        toolCallId: "streamed-tool",
        toolName: "bash",
        args: { command: "printf done" },
      } as AgentSessionEvent);
      const result = { content: [{ type: "text", text: "done" }] };
      yield* harness.pushEvent({
        type: "tool_execution_update",
        toolCallId: "streamed-tool",
        toolName: "bash",
        args: { command: "printf done" },
        partialResult: result,
      } as AgentSessionEvent);
      yield* harness.pushEvent({
        type: "tool_execution_end",
        toolCallId: "streamed-tool",
        toolName: "bash",
        result,
        isError: false,
      } as AgentSessionEvent);
      yield* harness.pushEvent({
        type: "tool_execution_start",
        toolCallId: "end-only-tool",
        toolName: "bash",
        args: { command: "printf final" },
      } as AgentSessionEvent);
      const richResult = {
        content: [
          { type: "text", text: "final" },
          { type: "image", data: "aW1hZ2U=", mimeType: "image/png" },
        ],
        details: { fullOutputPath: "/tmp/pi-output" },
      };
      yield* harness.pushEvent({
        type: "tool_execution_end",
        toolCallId: "end-only-tool",
        toolName: "bash",
        result: richResult,
        isError: true,
      } as AgentSessionEvent);
      yield* harness.waitFor(
        () => harness.events.filter(({ type }) => type === "item.completed").length === 2,
      );

      expect(
        harness.events.flatMap((event) =>
          event.type === "content.delta" && event.itemId ? [event.payload.delta] : [],
        ),
      ).toEqual(["done", "final"]);
      yield* harness.pushEvent({
        type: "agent_end",
        messages: [],
        willRetry: false,
      } as AgentSessionEvent);
      yield* harness.waitFor(
        () => harness.events.filter(({ type }) => type === "turn.completed").length === 1,
      );
      const items = (yield* harness.adapter.readThread(threadId)).turns[0]?.items ?? [];
      expect(items[0]).toMatchObject({ status: "completed", result });
      expect(items[1]).toMatchObject({ status: "failed", result: richResult });
    }),
  );

  it.effect("resolves an OMP extension cancellation exactly once", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      const threadId = ThreadId.make("omp-ui-cancel");
      yield* start(harness, threadId);
      yield* harness.pushExtension({
        type: "extension_ui_request",
        id: "approval-cancelled-by-runtime",
        method: "confirm",
        title: "bash",
        message: "run",
      });
      yield* harness.waitFor(() => harness.events.some(({ type }) => type === "request.opened"));
      yield* harness.pushExtension({
        type: "extension_ui_request",
        id: "cancel-frame",
        method: "cancel",
        targetId: "approval-cancelled-by-runtime",
      });
      yield* harness.waitFor(() => harness.events.some(({ type }) => type === "request.resolved"));
      expect(harness.events.filter(({ type }) => type === "request.resolved")).toHaveLength(1);
      expect(harness.extensionResponses).toEqual([]);
    }),
  );

  it.effect("uses the OMP branch dialect detected during startup", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      harness.responses.set(
        "get_available_commands",
        asResponse({
          type: "response",
          command: "get_available_commands",
          success: true,
          data: { commands: [{ name: "t3-approval-gate" }] },
        }),
      );
      const threadId = ThreadId.make("omp-branch-rollback");
      yield* start(harness, threadId, "approval-required");
      for (const input of ["one", "two"]) {
        yield* harness.adapter.sendTurn({ threadId, input, attachments: [] });
        yield* harness.pushEvent({ type: "agent_end", messages: [] } as AgentSessionEvent);
        const expected = input === "one" ? 1 : 2;
        yield* harness.waitFor(
          () => harness.events.filter(({ type }) => type === "turn.completed").length === expected,
        );
      }
      harness.responses.set(
        "get_branch_messages",
        asResponse({
          type: "response",
          command: "get_branch_messages",
          success: true,
          data: {
            messages: [
              { entryId: "one", text: "one" },
              { entryId: "two", text: "two" },
            ],
          },
        }),
      );
      harness.responses.set(
        "branch",
        asResponse({
          type: "response",
          command: "branch",
          success: true,
          data: { text: "two", cancelled: false },
        }),
      );

      const snapshot = yield* harness.adapter.rollbackThread(threadId, 1);
      expect(snapshot.turns).toHaveLength(1);
      expect(harness.requests.some(({ type }) => type === "get_branch_messages")).toBe(true);
      expect(harness.requests.some(({ type }) => type === "get_fork_messages")).toBe(false);
      expect(harness.requests.some(({ type }) => type === "branch")).toBe(true);
    }),
  );

  it.effect("persists acceptForSession until native session replacement", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      const threadId = ThreadId.make("pi-session-approval");
      yield* start(harness, threadId);
      const confirm = (id: string): RpcExtensionUIRequest => ({
        type: "extension_ui_request",
        id,
        method: "confirm",
        title: "bash",
        message: "printf ok",
      });
      yield* harness.pushExtension(confirm("approval-first"));
      yield* harness.waitFor(
        () => harness.events.filter(({ type }) => type === "request.opened").length === 1,
      );
      const opened = harness.events.find((event) => event.type === "request.opened");
      expect(opened?.requestId).toBeDefined();
      yield* harness.adapter.respondToRequest(
        threadId,
        ApprovalRequestId.make(String(opened?.requestId)),
        "acceptForSession",
      );

      yield* harness.pushExtension(confirm("approval-cached"));
      yield* harness.waitFor(() =>
        harness.extensionResponses.some(
          (response) => response.id === "approval-cached" && "confirmed" in response,
        ),
      );
      expect(harness.events.filter(({ type }) => type === "request.opened")).toHaveLength(1);

      harness.responses.set(
        "get_fork_messages",
        asResponse({
          type: "response",
          command: "get_fork_messages",
          success: true,
          data: { messages: [{ entryId: "one", text: "one" }] },
        }),
      );
      harness.responses.set(
        "new_session",
        asResponse({
          type: "response",
          command: "new_session",
          success: true,
          data: { cancelled: false },
        }),
      );
      yield* harness.adapter.rollbackThread(threadId, 1);
      yield* harness.pushExtension(confirm("approval-after-replacement"));
      yield* harness.waitFor(
        () => harness.events.filter(({ type }) => type === "request.opened").length === 2,
      );
    }),
  );
});
