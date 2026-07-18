import type {
  CanonicalItemType,
  CanonicalRequestType,
  RuntimeContentStreamKind,
  RuntimeItemId,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Option from "effect/Option";

const encodeJsonString = Schema.encodeSync(Schema.UnknownFromJsonString);
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

export function summarizePiToolArgs(args: unknown): string | undefined {
  const input = Option.getOrUndefined(decodeUnknownRecord(args));
  if (input === undefined) return undefined;
  const command = input["command"] ?? input["cmd"];
  if (typeof command === "string" && command.trim().length > 0) return command.trim().slice(0, 400);
  const path = input["file_path"] ?? input["path"] ?? input["filePath"];
  if (typeof path === "string" && path.trim().length > 0) return path.trim().slice(0, 400);
  const pattern = input["pattern"] ?? input["query"] ?? input["description"];
  if (typeof pattern === "string" && pattern.trim().length > 0) return pattern.trim().slice(0, 400);
  try {
    const serialized = encodeJsonString(input);
    return serialized.length <= 400 ? serialized : `${serialized.slice(0, 397)}...`;
  } catch {
    return undefined;
  }
}

export function piToolTitle(toolName: string, args: unknown): string {
  return summarizePiToolArgs(args) ?? toolName;
}

export function piToolError(result: unknown): string | undefined {
  const input = Option.getOrUndefined(decodeUnknownRecord(result));
  if (input === undefined) return undefined;
  const error = input["error"] ?? input["message"];
  return typeof error === "string" && error.trim().length > 0 ? error.trim() : undefined;
}
