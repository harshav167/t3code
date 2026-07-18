import { describe, expect, it } from "@effect/vitest";
import type { ProviderApprovalDecision } from "@t3tools/contracts";

import {
  buildPiApprovalResponse,
  buildPiUserInputQuestion,
  buildPiUserInputResponse,
  isPiApprovalConfirmed,
  parseNumberedList,
} from "./PiExtensionUi.ts";
import {
  classifyPiApprovalRequestType,
  classifyPiToolItemType,
  piToolOutputStreamKind,
  summarizePiToolArgs,
} from "./PiTools.ts";

describe("classifyPiToolItemType", () => {
  it("maps shell / exec tools to command execution", () => {
    expect(classifyPiToolItemType("bash")).toBe("command_execution");
    expect(classifyPiToolItemType("run_shell_command")).toBe("command_execution");
    expect(classifyPiToolItemType("terminal_exec")).toBe("command_execution");
  });

  it("maps write / edit / patch tools to file changes", () => {
    expect(classifyPiToolItemType("write_file")).toBe("file_change");
    expect(classifyPiToolItemType("apply_patch")).toBe("file_change");
    expect(classifyPiToolItemType("edit")).toBe("file_change");
    expect(classifyPiToolItemType("read_file")).toBe("dynamic_tool_call");
  });

  it("maps only commands and file changes to specialized output streams", () => {
    expect(piToolOutputStreamKind("bash")).toBe("command_output");
    expect(piToolOutputStreamKind("write_file")).toBe("file_change_output");
    expect(piToolOutputStreamKind("read_file")).toBe("unknown");
    expect(piToolOutputStreamKind("web_search")).toBe("unknown");
  });

  it("classifies agent, mcp, search, and image tools", () => {
    expect(classifyPiToolItemType("subagent")).toBe("collab_agent_tool_call");
    expect(classifyPiToolItemType("task")).toBe("collab_agent_tool_call");
    expect(classifyPiToolItemType("mcp_call")).toBe("mcp_tool_call");
    expect(classifyPiToolItemType("web_search")).toBe("web_search");
    expect(classifyPiToolItemType("view_image")).toBe("image_view");
  });

  it("falls back to a dynamic tool call for unknown tools", () => {
    expect(classifyPiToolItemType("something_else")).toBe("dynamic_tool_call");
  });
});

describe("classifyPiApprovalRequestType", () => {
  it("derives the approval request type from the tool hint", () => {
    expect(classifyPiApprovalRequestType("bash")).toBe("command_execution_approval");
    expect(classifyPiApprovalRequestType("Run bash?")).toBe("command_execution_approval");
    expect(classifyPiApprovalRequestType("write_file")).toBe("file_change_approval");
  });

  it("maps non-command/non-file tools to dynamic_tool_call (a surfaced approval)", () => {
    expect(classifyPiApprovalRequestType("web_search")).toBe("dynamic_tool_call");
    expect(classifyPiApprovalRequestType("mcp__server__tool")).toBe("dynamic_tool_call");
    expect(classifyPiApprovalRequestType("some_unknown_tool")).toBe("dynamic_tool_call");
  });
});

describe("summarizePiToolArgs", () => {
  it("prefers the command, then path, then pattern fields", () => {
    expect(summarizePiToolArgs({ command: "ls -la" })).toBe("ls -la");
    expect(summarizePiToolArgs({ file_path: "/tmp/x.ts" })).toBe("/tmp/x.ts");
    expect(summarizePiToolArgs({ query: "find TODOs" })).toBe("find TODOs");
  });

  it("serializes other objects and ignores non-objects", () => {
    expect(summarizePiToolArgs({ foo: "bar" })).toBe('{"foo":"bar"}');
    expect(summarizePiToolArgs(undefined)).toBeUndefined();
    expect(summarizePiToolArgs("string")).toBeUndefined();
  });
});

describe("parseNumberedList", () => {
  it("parses a title + numbered options", () => {
    expect(parseNumberedList("Pick one\n1. Alpha\n2. Beta")).toEqual({
      title: "Pick one",
      items: [
        { index: 1, label: "Alpha" },
        { index: 2, label: "Beta" },
      ],
    });
  });

  it("returns null when fewer than two options are present", () => {
    expect(parseNumberedList("Just a title\n1. Only")).toBeNull();
    expect(parseNumberedList("No options here")).toBeNull();
  });
});

describe("isPiApprovalConfirmed / buildPiApprovalResponse", () => {
  it("confirms accept and acceptForSession, rejects everything else", () => {
    expect(isPiApprovalConfirmed("accept")).toBe(true);
    expect(isPiApprovalConfirmed("acceptForSession")).toBe(true);
    expect(isPiApprovalConfirmed("decline")).toBe(false);
    expect(isPiApprovalConfirmed("cancel")).toBe(false);
  });

  it("round-trips a confirm request into an extension_ui_response", () => {
    expect(classifyPiApprovalRequestType("bash")).toBe("command_execution_approval");
    expect(buildPiApprovalResponse("ui-42", "accept")).toEqual({
      type: "extension_ui_response",
      id: "ui-42",
      confirmed: true,
    });
    const decline: ProviderApprovalDecision = "decline";
    expect(buildPiApprovalResponse("ui-42", decline)).toEqual({
      type: "extension_ui_response",
      id: "ui-42",
      confirmed: false,
    });
  });
});

describe("buildPiUserInputResponse", () => {
  it("echoes a plain string answer for select / input requests", () => {
    expect(
      buildPiUserInputResponse(
        { piId: "ui-1", questionId: "q1", method: "select" },
        { q1: "Option A" },
      ),
    ).toEqual({ type: "extension_ui_response", id: "ui-1", value: "Option A" });
  });

  it("maps numbered-list selections back to 1-based comma-joined indices", () => {
    expect(
      buildPiUserInputResponse(
        {
          piId: "ui-2",
          questionId: "q2",
          method: "input",
          numberedOptions: ["Alpha", "Beta", "Gamma"],
        },
        { q2: ["Alpha", "Gamma"] },
      ),
    ).toEqual({ type: "extension_ui_response", id: "ui-2", value: "1,3" });
  });

  it("handles a single numbered selection provided as a string", () => {
    expect(
      buildPiUserInputResponse(
        {
          piId: "ui-3",
          questionId: "q3",
          method: "input",
          numberedOptions: ["Alpha", "Beta"],
        },
        { q3: "Beta" },
      ),
    ).toEqual({ type: "extension_ui_response", id: "ui-3", value: "2" });
  });

  it("round-trips the selected index when numbered labels are duplicated", () => {
    const projected = buildPiUserInputQuestion({
      questionId: "q-duplicate",
      method: "input",
      title: "Choose\n1. Same\n2. Same",
    });
    expect(projected.question.options.map(({ label }) => label)).toEqual(["1. Same", "2. Same"]);
    expect(
      buildPiUserInputResponse(
        {
          piId: "ui-duplicate",
          questionId: "q-duplicate",
          method: "input",
          numberedOptions: projected.numberedOptions ?? [],
        },
        { "q-duplicate": ["2. Same"] },
      ),
    ).toEqual({ type: "extension_ui_response", id: "ui-duplicate", value: "2" });
  });

  it("returns an empty value when the answer is missing", () => {
    expect(
      buildPiUserInputResponse({ piId: "ui-4", questionId: "q4", method: "editor" }, {}),
    ).toEqual({ type: "extension_ui_response", id: "ui-4", value: "" });
  });
});
