import type {
  ProviderApprovalDecision,
  ProviderUserInputAnswers,
  UserInputQuestion,
} from "@t3tools/contracts";
import type { RpcExtensionUIResponse } from "./PiRpcProtocol.ts";

export interface NumberedOption {
  readonly index: number;
  readonly label: string;
}

export type PendingNumberedOption = string | NumberedOption;

export interface PendingUserInput {
  readonly piId: string;
  readonly questionId: string;
  readonly method: "select" | "input" | "editor";
  readonly numberedOptions?: ReadonlyArray<PendingNumberedOption>;
}

function numberedOptionLabel(
  options: ReadonlyArray<PendingNumberedOption>,
  option: NumberedOption,
): string {
  const duplicated = options.some(
    (other) => other !== option && typeof other !== "string" && other.label === option.label,
  );
  return duplicated ? `${option.index}. ${option.label}` : option.label;
}

export function parseNumberedList(
  text: string,
): { readonly title: string; readonly items: ReadonlyArray<NumberedOption> } | null {
  const lines = text.split("\n");
  const items: NumberedOption[] = [];
  for (const line of lines.slice(1)) {
    const match = /^(\d+)\.\s+(.+)$/.exec(line.trim());
    if (match?.[1] && match[2]) items.push({ index: Number(match[1]), label: match[2] });
  }
  return items.length >= 2 ? { title: lines[0] ?? text, items } : null;
}

export function buildPiApprovalResponse(
  piId: string,
  decision: ProviderApprovalDecision,
): RpcExtensionUIResponse {
  return {
    type: "extension_ui_response",
    id: piId,
    confirmed: isPiApprovalConfirmed(decision),
  };
}

export function isPiApprovalConfirmed(decision: ProviderApprovalDecision): boolean {
  return decision === "accept" || decision === "acceptForSession";
}

export function buildPiUserInputResponse(
  pending: PendingUserInput,
  answers: ProviderUserInputAnswers,
): RpcExtensionUIResponse {
  const answer = answers[pending.questionId];
  if (pending.method === "input" && pending.numberedOptions) {
    const selected = Array.isArray(answer)
      ? answer.map(String)
      : typeof answer === "string" && answer.length > 0
        ? [answer]
        : [];
    const indices = selected.flatMap((label) => {
      const optionIndex = pending.numberedOptions?.findIndex((entry) =>
        typeof entry === "string"
          ? entry === label
          : numberedOptionLabel(pending.numberedOptions ?? [], entry) === label,
      );
      if (optionIndex === undefined || optionIndex < 0) return [];
      const option = pending.numberedOptions?.[optionIndex];
      return option === undefined
        ? []
        : [String(typeof option === "string" ? optionIndex + 1 : option.index)];
    });
    return { type: "extension_ui_response", id: pending.piId, value: indices.join(",") };
  }
  return {
    type: "extension_ui_response",
    id: pending.piId,
    value: typeof answer === "string" ? answer : "",
  };
}

export function buildPiUserInputQuestion(input: {
  readonly questionId: string;
  readonly method: PendingUserInput["method"];
  readonly title: string;
  readonly options?: ReadonlyArray<string>;
}): {
  readonly question: UserInputQuestion;
  readonly numberedOptions?: ReadonlyArray<NumberedOption>;
} {
  if (input.method === "select") {
    return {
      question: {
        id: input.questionId,
        header: input.title.slice(0, 12) || "Select",
        question: input.title,
        options: (input.options ?? []).map((label) => ({ label, description: label })),
        multiSelect: false,
      },
    };
  }
  const numbered = input.method === "input" ? parseNumberedList(input.title) : null;
  if (numbered) {
    return {
      question: {
        id: input.questionId,
        header: numbered.title.slice(0, 12) || "Select",
        question: numbered.title,
        options: numbered.items.map((item) => ({
          label: numberedOptionLabel(numbered.items, item),
          description: item.label,
        })),
        multiSelect: true,
      },
      numberedOptions: numbered.items,
    };
  }
  return {
    question: {
      id: input.questionId,
      header: input.title.slice(0, 12) || "Input",
      question: input.title || "Input",
      options: [],
      multiSelect: false,
    },
  };
}
