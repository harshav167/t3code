import type { ModelCapabilities, ModelSelection, ServerProviderModel } from "@t3tools/contracts";

import { buildSelectOptionDescriptor } from "../providerSnapshot.ts";
import type {
  ModelInfo,
  PiImageContent,
  PiThinkingLevel,
  RpcCommand,
  RpcResponse,
} from "./PiRpcTypes.ts";
import { createModelCapabilities, getModelSelectionStringOptionValue } from "@t3tools/shared/model";

export type { ModelInfo, PiImageContent, PiThinkingLevel, RpcCommand, RpcResponse };
export type PiRpcDialect = "pi" | "omp";

export function splitPiModelSlug(slug: string): { provider: string; id: string } | null {
  const trimmed = slug.trim();
  const index = trimmed.indexOf("/");
  return index <= 0 || index >= trimmed.length - 1
    ? null
    : { provider: trimmed.slice(0, index), id: trimmed.slice(index + 1) };
}

export function piModelSlug(model: Pick<ModelInfo, "provider" | "id">): string {
  return `${model.provider}/${model.id}`;
}

export type PiTurnCommand = Extract<RpcCommand, { type: "prompt" } | { type: "steer" }>;

export function piImageContentFromBytes(input: {
  readonly mimeType: string;
  readonly bytes: Uint8Array;
}): PiImageContent {
  return {
    type: "image",
    data: Buffer.from(input.bytes).toString("base64"),
    mimeType: input.mimeType,
  };
}

export function buildPiTurnCommand(input: {
  readonly isMidTurn: boolean;
  readonly message: string;
  readonly images?: ReadonlyArray<PiImageContent>;
}): PiTurnCommand {
  const images = input.images && input.images.length > 0 ? [...input.images] : undefined;
  return input.isMidTurn
    ? { type: "steer", message: input.message, ...(images ? { images } : {}) }
    : { type: "prompt", message: input.message, ...(images ? { images } : {}) };
}

const PI_THINKING_LEVELS = [
  { value: "off", label: "Off" },
  { value: "minimal", label: "Minimal" },
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium", isDefault: true },
  { value: "high", label: "High" },
  { value: "xhigh", label: "Extra High" },
  { value: "max", label: "Max" },
] as const;
type PiThinkingLevelMap = Partial<Record<PiThinkingLevel, string | null>>;
type PiModelInfo = ModelInfo & {
  readonly name?: string;
  readonly thinkingLevelMap?: PiThinkingLevelMap;
};
export const PI_THINKING_OPTION_ID = "thinking";
export const PI_THINKING_LEVEL_VALUES = PI_THINKING_LEVELS.map(
  ({ value }) => value,
) as ReadonlyArray<PiThinkingLevel>;
const PI_THINKING_LEVEL_SET: ReadonlySet<string> = new Set(PI_THINKING_LEVEL_VALUES);

export function asPiThinkingLevel(value: string | undefined): PiThinkingLevel | undefined {
  return value !== undefined && PI_THINKING_LEVEL_SET.has(value)
    ? (value as PiThinkingLevel)
    : undefined;
}

export function resolvePiThinkingLevel(
  modelSelection: ModelSelection | null | undefined,
): PiThinkingLevel | undefined {
  return asPiThinkingLevel(
    getModelSelectionStringOptionValue(modelSelection, PI_THINKING_OPTION_ID),
  );
}

export type PiModelSwitchPlan =
  | { readonly kind: "noop" }
  | { readonly kind: "invalid"; readonly slug: string }
  | {
      readonly kind: "switch";
      readonly provider: string;
      readonly modelId: string;
      readonly slug: string;
    };

export function planPiModelSwitch(
  currentModel: string | undefined,
  requestedModel: string | undefined,
): PiModelSwitchPlan {
  if (!requestedModel || requestedModel === currentModel) return { kind: "noop" };
  const parsed = splitPiModelSlug(requestedModel);
  return parsed
    ? { kind: "switch", provider: parsed.provider, modelId: parsed.id, slug: requestedModel }
    : { kind: "invalid", slug: requestedModel };
}

export function piModelCapabilities(
  model: boolean | Pick<PiModelInfo, "reasoning" | "thinkingLevelMap">,
): ModelCapabilities {
  const reasoning = typeof model === "boolean" ? model : model.reasoning === true;
  return createModelCapabilities({
    optionDescriptors: reasoning
      ? [
          buildSelectOptionDescriptor({
            id: PI_THINKING_OPTION_ID,
            label: "Thinking",
            options: PI_THINKING_LEVELS.filter(({ value }) => {
              if (typeof model === "boolean") return true;
              const mapped = model.thinkingLevelMap?.[value];
              if (mapped === null) return false;
              return value === "xhigh" || value === "max" ? mapped !== undefined : true;
            }).map((level) => ({ ...level })),
          }),
        ]
      : [],
  });
}

export function piModelInfoToServerModel(model: PiModelInfo): ServerProviderModel {
  const slug = piModelSlug(model);
  const rawName = "name" in model ? model.name : undefined;
  return {
    slug,
    name: typeof rawName === "string" && rawName.trim() ? rawName.trim() : model.id,
    isCustom: false,
    capabilities: piModelCapabilities(model),
  };
}

function responseData(response: RpcResponse | undefined): Record<string, unknown> | null {
  if (!response || response.type !== "response" || !response.success) return null;
  const data = "data" in response ? response.data : undefined;
  return data !== null && typeof data === "object" ? (data as Record<string, unknown>) : null;
}

export function piPromptAgentInvoked(response: RpcResponse | undefined): boolean | undefined {
  if (!piResponseSucceeded(response, "prompt")) return undefined;
  const agentInvoked = responseData(response)?.["agentInvoked"];
  return typeof agentInvoked === "boolean" ? agentInvoked : undefined;
}

export function extractSessionFile(response: RpcResponse | undefined): string | undefined {
  const sessionFile = responseData(response)?.["sessionFile"];
  return typeof sessionFile === "string" && sessionFile.trim() ? sessionFile.trim() : undefined;
}

export function extractAvailableModels(
  response: RpcResponse | undefined,
): ReadonlyArray<PiModelInfo> {
  const models = responseData(response)?.["models"];
  if (!Array.isArray(models)) return [];
  return models.flatMap((entry) => {
    if (entry === null || typeof entry !== "object") return [];
    const model = entry as Record<string, unknown>;
    return typeof model["provider"] === "string" && typeof model["id"] === "string"
      ? [model as unknown as PiModelInfo]
      : [];
  });
}

export function piResponseHasCommand(
  response: RpcResponse | undefined,
  commandName: string,
): boolean {
  const commands = responseData(response)?.["commands"];
  return (
    Array.isArray(commands) &&
    commands.some(
      (entry) =>
        entry !== null &&
        typeof entry === "object" &&
        (entry as Record<string, unknown>)["name"] === commandName,
    )
  );
}

export function extractLastAssistantText(response: RpcResponse | undefined): string | null {
  const text = responseData(response)?.["text"];
  return typeof text === "string" ? text : null;
}

export function piResponseSucceeded(response: RpcResponse | undefined, command: string): boolean {
  return Boolean(response?.success && response.command === command);
}

export function extractForkMessages(
  response: RpcResponse | undefined,
): ReadonlyArray<{ readonly entryId: string; readonly text: string }> {
  const messages = responseData(response)?.["messages"];
  if (!Array.isArray(messages)) return [];
  return messages.flatMap((entry) => {
    if (entry === null || typeof entry !== "object") return [];
    const value = entry as Record<string, unknown>;
    return typeof value["entryId"] === "string"
      ? [
          {
            entryId: value["entryId"],
            text: typeof value["text"] === "string" ? value["text"] : "",
          },
        ]
      : [];
  });
}

export function piForkSucceeded(response: RpcResponse | undefined): boolean {
  return Boolean(response?.success && responseData(response)?.["cancelled"] !== true);
}

export function resolveForkTargetEntryId(
  userMessages: ReadonlyArray<{ readonly entryId: string }>,
  numTurns: number,
): { readonly kind: "fork"; readonly entryId: string } | { readonly kind: "reset" } | null {
  if (numTurns <= 0 || userMessages.length === 0) return null;
  const targetIndex = userMessages.length - numTurns;
  return targetIndex <= 0
    ? { kind: "reset" }
    : { kind: "fork", entryId: userMessages[targetIndex]!.entryId };
}
