import type { ModelCapabilities, ModelSelection, ServerProviderModel } from "@t3tools/contracts";

import { buildSelectOptionDescriptor } from "../providerSnapshot.ts";
import { asPiThinkingLevel, PI_THINKING_LEVELS, type PiDiscoveredModel } from "./PiRpcDialect.ts";
import type {
  ModelInfo,
  PiImageContent,
  PiThinkingLevel,
  RpcCommand,
  RpcResponse,
} from "./PiRpcTypes.ts";
import { createModelCapabilities, getModelSelectionStringOptionValue } from "@t3tools/shared/model";

export type { ModelInfo, PiImageContent, PiThinkingLevel, RpcCommand, RpcResponse };
export { asPiThinkingLevel };
export {
  extractAvailableModels,
  extractForkMessages,
  extractLastAssistantText,
  extractSessionFile,
  piForkSucceeded,
  piPromptAgentInvoked,
  piResponseHasCommand,
  piResponseSucceeded,
  resolveForkTargetEntryId,
} from "./PiModelResponse.ts";

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

type PiThinkingLevelMap = Partial<Record<PiThinkingLevel, string | null>>;
type PiModelInfo = ModelInfo & {
  readonly name?: string;
  readonly thinkingLevelMap?: PiThinkingLevelMap;
};
export const PI_THINKING_OPTION_ID = "thinking";
export const PI_THINKING_LEVEL_VALUES = PI_THINKING_LEVELS;

const PI_THINKING_LABELS: Readonly<Record<PiThinkingLevel, string>> = {
  off: "Off",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra High",
  max: "Max",
};

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
  model:
    | boolean
    | Pick<PiModelInfo, "reasoning" | "thinkingLevelMap">
    | Pick<PiDiscoveredModel, "reasoning" | "thinkingLevels" | "defaultThinkingLevel">,
): ModelCapabilities {
  const reasoning = typeof model === "boolean" ? model : model.reasoning === true;
  const levels =
    typeof model !== "boolean" && "thinkingLevels" in model
      ? model.thinkingLevels
      : PI_THINKING_LEVELS.filter((level) => {
          if (typeof model === "boolean") return true;
          const mapped = model.thinkingLevelMap?.[level];
          if (mapped === null) return false;
          return level === "xhigh" || level === "max" ? mapped !== undefined : true;
        });
  const defaultThinkingLevel =
    typeof model !== "boolean" && "defaultThinkingLevel" in model
      ? model.defaultThinkingLevel
      : "medium";
  return createModelCapabilities({
    optionDescriptors: reasoning
      ? [
          buildSelectOptionDescriptor({
            id: PI_THINKING_OPTION_ID,
            label: "Thinking",
            options: levels.map((level) => ({
              value: level,
              label: PI_THINKING_LABELS[level],
              ...(level === defaultThinkingLevel ? { isDefault: true } : {}),
            })),
          }),
        ]
      : [],
  });
}

export function piModelInfoToServerModel(
  model: PiModelInfo | PiDiscoveredModel,
): ServerProviderModel {
  const slug = piModelSlug(model);
  const rawName = "name" in model ? model.name : undefined;
  return {
    slug,
    name: typeof rawName === "string" && rawName.trim() ? rawName.trim() : model.id,
    isCustom: false,
    capabilities: piModelCapabilities(model),
  };
}
