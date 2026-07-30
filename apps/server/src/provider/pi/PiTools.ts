import type {
  CanonicalItemType,
  CanonicalRequestType,
  RuntimeContentStreamKind,
  RuntimeItemId,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

const UnknownRecord = Schema.Record(Schema.String, Schema.Unknown);
const decodeUnknownRecord = Schema.decodeUnknownOption(UnknownRecord);

export interface PiToolItem {
  readonly id: RuntimeItemId;
  readonly type: CanonicalItemType;
  readonly toolName: string;
  args: unknown;
  output?: string;
  result?: unknown;
  status?: "completed" | "failed";
}

export function piToolResultText(result: unknown): string {
  if (typeof result === "string") return result;
  if (!result || typeof result !== "object" || !("content" in result)) return "";
  if (!Array.isArray(result.content)) return "";
  return result.content
    .flatMap((part) =>
      part &&
      typeof part === "object" &&
      "type" in part &&
      part.type === "text" &&
      "text" in part &&
      typeof part.text === "string"
        ? [part.text]
        : [],
    )
    .join("");
}

export function classifyPiToolItemType(toolName: string): CanonicalItemType {
  const tokens = new Set(
    toolName
      .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
      .replace(/[^a-zA-Z0-9]+/g, " ")
      .toLowerCase()
      .split(/\s+/)
      .filter((token) => token.length > 0),
  );
  const has = (...words: ReadonlyArray<string>): boolean => words.some((word) => tokens.has(word));

  if (has("mcp")) return "mcp_tool_call";
  if (has("agent", "subagent", "task", "skill")) return "collab_agent_tool_call";
  if (has("bash", "shell", "command", "terminal", "exec")) return "command_execution";
  if (has("edit", "write", "patch", "apply")) return "file_change";
  if (has("search", "web")) return "web_search";
  if (has("image")) return "image_view";
  return "dynamic_tool_call";
}

export function classifyPiApprovalRequestType(toolHint: string): CanonicalRequestType {
  switch (classifyPiToolItemType(toolHint)) {
    case "command_execution":
      return "command_execution_approval";
    case "file_change":
      return "file_change_approval";
    default:
      return "dynamic_tool_call";
  }
}

export function piToolOutputStreamKind(toolName: string): RuntimeContentStreamKind {
  switch (classifyPiToolItemType(toolName)) {
    case "command_execution":
      return "command_output";
    case "file_change":
      return "file_change_output";
    default:
      return "unknown";
  }
}

function toolSummaryText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim().slice(0, 400)
    : undefined;
}

function isPiSkillTool(toolName: string): boolean {
  return /^skill:\/\//i.test(toolName.trim());
}

function summarizePiControlArgs(input: Readonly<Record<string, unknown>>): string | undefined {
  const op = toolSummaryText(input["op"])?.toLowerCase();
  if (op === "init") {
    const taskCount = Array.isArray(input["list"]) ? input["list"].length : 0;
    return taskCount > 0
      ? `Started ${taskCount} task${taskCount === 1 ? "" : "s"}`
      : "Started task";
  }
  if (op === "done") {
    const task = toolSummaryText(input["task"]);
    return task ? `Completed ${task}` : "Completed task";
  }
  if (op === "wait") {
    return "Waiting for task updates";
  }
  if (op) {
    return `Updated ${op}`;
  }
  return toolSummaryText(input["context"]) ? "Sent task context" : undefined;
}

function readablePiToolName(toolName: string): string {
  const trimmed = toolName.trim();
  const skill = /^skill:\/\/([^/\s]+)$/i.exec(trimmed);
  return skill ? `Loaded ${skill[1]} skill` : trimmed || "Tool call";
}

export function summarizePiToolArgs(args: unknown, toolName?: string): string | undefined {
  const input = Option.getOrUndefined(decodeUnknownRecord(args));
  if (input === undefined) return undefined;
  if (toolName !== undefined && isPiSkillTool(toolName)) return undefined;
  const controlSummary = summarizePiControlArgs(input);
  if (controlSummary) return controlSummary;
  const command = input["command"] ?? input["cmd"];
  const commandSummary = toolSummaryText(command);
  if (commandSummary) return commandSummary;
  const path = input["file_path"] ?? input["path"] ?? input["filePath"];
  const pathSummary = toolSummaryText(path);
  if (pathSummary) return pathSummary;
  const pattern = input["pattern"] ?? input["query"] ?? input["description"];
  return toolSummaryText(pattern);
}

export function piToolTitle(toolName: string, args: unknown): string {
  if (isPiSkillTool(toolName)) return readablePiToolName(toolName);
  return summarizePiToolArgs(args, toolName) ?? readablePiToolName(toolName);
}

export function piToolError(result: unknown): string | undefined {
  const input = Option.getOrUndefined(decodeUnknownRecord(result));
  if (input === undefined) return undefined;
  const error = input["error"] ?? input["message"];
  return typeof error === "string" && error.trim().length > 0 ? error.trim() : undefined;
}
