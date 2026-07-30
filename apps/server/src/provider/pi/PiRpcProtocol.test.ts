import { describe, expect, it } from "@effect/vitest";

import { decodePiStdoutLine } from "./PiRpcProtocol.ts";

const state = {
  sessionId: "session-1",
  thinkingLevel: "medium",
  isStreaming: false,
  isCompacting: false,
  steeringMode: "all",
  followUpMode: "all",
  autoCompactionEnabled: true,
  messageCount: 1,
  pendingMessageCount: 0,
};

describe("decodePiStdoutLine", () => {
  it("ignores blank and diagnostic stdout", () => {
    expect(decodePiStdoutLine("   ")).toEqual({ _tag: "Ignored" });
    expect(decodePiStdoutLine("pi diagnostic output")).toEqual({ _tag: "Ignored" });
  });

  it("decodes valid responses, extension requests, and events", () => {
    expect(
      decodePiStdoutLine(
        JSON.stringify({
          type: "response",
          id: "state-1",
          command: "get_state",
          success: true,
          data: state,
        }),
      ),
    ).toMatchObject({ _tag: "Message", message: { _tag: "response", id: "state-1" } });
    expect(
      decodePiStdoutLine(
        JSON.stringify({
          type: "extension_ui_request",
          id: "ui-1",
          method: "confirm",
          title: "bash",
          message: "run command",
        }),
      ),
    ).toMatchObject({ _tag: "Message", message: { _tag: "extension-ui" } });
    expect(decodePiStdoutLine('{"type":"agent_start"}')).toMatchObject({
      _tag: "Message",
      message: { _tag: "event" },
    });
  });

  it("decodes OMP control, state, branch, and extension UI frames", () => {
    for (const line of [
      '{"type":"ready"}',
      '{"type":"available_commands_update","commands":[{"name":"t3-approval-gate","source":"extension"}]}',
      '{"type":"prompt_result","id":"prompt-1","agentInvoked":true}',
      '{"type":"command_output","text":"ok"}',
      '{"type":"session_info_update","sessionId":"omp-1","title":"Test"}',
      '{"type":"config_update","thinkingLevel":"high"}',
      '{"type":"notice","level":"info","message":"hello"}',
      '{"type":"subagent_progress","payload":{}}',
    ]) {
      expect(decodePiStdoutLine(line)).toMatchObject({
        _tag: "Message",
        message: { _tag: "control" },
      });
    }
    expect(
      decodePiStdoutLine(
        '{"type":"response","id":"state-omp","command":"get_state","success":true,"data":{"sessionId":"omp-1","queuedMessageCount":0}}',
      ),
    ).toMatchObject({ _tag: "Message", message: { _tag: "response", id: "state-omp" } });
    expect(
      decodePiStdoutLine(
        '{"type":"response","id":"branch-1","command":"branch","success":true,"data":{"text":"x","cancelled":false}}',
      ),
    ).toMatchObject({ _tag: "Message", message: { _tag: "response", id: "branch-1" } });
    expect(
      decodePiStdoutLine(
        '{"type":"extension_ui_request","id":"cancel-1","method":"cancel","targetId":"ui-1"}',
      ),
    ).toMatchObject({ _tag: "Message", message: { _tag: "extension-ui" } });
    expect(
      decodePiStdoutLine(
        '{"type":"extension_ui_request","id":"url-1","method":"open_url","url":"https://example.com"}',
      ),
    ).toMatchObject({ _tag: "Message", message: { _tag: "extension-ui" } });
    expect(decodePiStdoutLine('{"type":"agent_end","messages":[]}')).toMatchObject({
      _tag: "Message",
      message: { _tag: "event" },
    });
  });

  it("accepts OMP ready frames that include protocol metadata", () => {
    expect(
      decodePiStdoutLine(
        '{"type":"ready","protocolVersion":1,"supportedProtocolVersions":[1,2],"maxFrameBytes":1048576,"maxReassembledFrameBytes":67108864}',
      ),
    ).toMatchObject({
      _tag: "Message",
      message: { _tag: "control" },
    });
  });

  it("keeps an identifiable malformed response isolated", () => {
    expect(
      decodePiStdoutLine(
        JSON.stringify({
          type: "response",
          id: "state-1",
          command: "get_state",
          success: true,
          data: { sessionId: 42 },
        }),
      ),
    ).toMatchObject({ _tag: "InvalidResponse", id: "state-1" });
  });

  it("ignores valid id-less command responses emitted for fire-and-forget calls", () => {
    expect(decodePiStdoutLine('{"type":"response","command":"abort","success":true}')).toEqual({
      _tag: "Ignored",
    });
    expect(
      decodePiStdoutLine(
        '{"type":"response","command":"get_commands","success":false,"error":"Unknown command"}',
      ),
    ).toEqual({ _tag: "Ignored" });
  });

  it.each(["select", "confirm", "input"])(
    "identifies malformed %s extension requests for cancellation",
    (method) => {
      expect(
        decodePiStdoutLine(
          JSON.stringify({ type: "extension_ui_request", id: `ui-${method}`, method }),
        ),
      ).toMatchObject({ _tag: "InvalidExtensionUiRequest", id: `ui-${method}` });
    },
  );

  it("ignores unknown frames without retaining their payload", () => {
    expect(decodePiStdoutLine('{"type":"future_optional_frame","value":1}')).toEqual({
      _tag: "Ignored",
    });
  });

  it("treats malformed required protocol objects as fatal", () => {
    expect(decodePiStdoutLine('{"type":"response","command":"get_state"}')).toMatchObject({
      _tag: "FatalProtocolError",
    });
    expect(decodePiStdoutLine('{"type":"prompt_result","agentInvoked":false}')).toMatchObject({
      _tag: "Message",
      message: { _tag: "control" },
    });
    expect(decodePiStdoutLine("{not-json}")).toMatchObject({ _tag: "FatalProtocolError" });
    expect(
      decodePiStdoutLine('{"type":"message_update","assistantMessageEvent":{"type":"text_delta"}}'),
    ).toMatchObject({ _tag: "FatalProtocolError" });
  });
});
