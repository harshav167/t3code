import type { PiSettings, ProviderSessionStartInput } from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import type { PiThinkingLevel } from "./PiRpcTypes.ts";

export interface PiRpcLaunch {
  readonly binaryPath: string;
  readonly args: ReadonlyArray<string>;
  readonly environment: NodeJS.ProcessEnv;
}

export type PiRpcLaunchPurpose =
  | { readonly kind: "discovery" }
  | {
      readonly kind: "session";
      readonly runtimeMode: ProviderSessionStartInput["runtimeMode"];
      readonly resumeCursor?: unknown;
      readonly model?: string;
      readonly thinking?: PiThinkingLevel;
      readonly approvalExtensionPath?: string;
    };

export interface PiRpcLaunchInput {
  readonly settings: PiSettings;
  readonly environment: NodeJS.ProcessEnv;
  readonly extensionPaths: ReadonlyArray<string>;
  readonly purpose: PiRpcLaunchPurpose;
}

export type PiRpcLaunchResult =
  | { readonly kind: "ok"; readonly launch: PiRpcLaunch }
  | { readonly kind: "approval-gate-missing" };

export function resolvePiApprovalLaunch(
  binaryPath: string,
  runtimeMode: ProviderSessionStartInput["runtimeMode"],
):
  | { readonly kind: "none" }
  | { readonly kind: "pi-extension" }
  | { readonly kind: "omp-native"; readonly mode: "always-ask" | "write" } {
  if (runtimeMode === "full-access") return { kind: "none" };
  const executable = binaryPath.split(/[\\/]/u).at(-1)?.toLowerCase();
  switch (executable) {
    case "omp":
    case "omp.exe":
    case "oh-my-pi":
    case "oh-my-pi.exe":
      return {
        kind: "omp-native",
        mode: runtimeMode === "approval-required" ? "always-ask" : "write",
      };
    default:
      return { kind: "pi-extension" };
  }
}

const ResumeCursor = Schema.Struct({ sessionFile: Schema.String });
const decodeResumeCursor = Schema.decodeUnknownOption(ResumeCursor);

function resumeSessionFile(resumeCursor: unknown): string | undefined {
  return Option.getOrUndefined(decodeResumeCursor(resumeCursor))?.sessionFile;
}

export function buildPiRpcLaunch(input: PiRpcLaunchInput): PiRpcLaunchResult {
  const binaryPath = input.settings.binaryPath || "pi";
  const args = ["--mode", "rpc"];
  let environment = input.environment;
  if (input.purpose.kind === "discovery") {
    args.push("--no-session");
  } else {
    const sessionFile = resumeSessionFile(input.purpose.resumeCursor);
    if (sessionFile !== undefined) args.push("--session", sessionFile);
    if (input.purpose.model !== undefined) args.push("--model", input.purpose.model);
    if (input.purpose.thinking !== undefined) args.push("--thinking", input.purpose.thinking);
    const approval = resolvePiApprovalLaunch(binaryPath, input.purpose.runtimeMode);
    if (approval.kind === "pi-extension" && input.purpose.approvalExtensionPath === undefined) {
      return { kind: "approval-gate-missing" };
    }
    if (approval.kind === "omp-native") {
      args.push("--approval-mode", approval.mode);
    } else if (approval.kind === "pi-extension") {
      const approvalExtensionPath = input.purpose.approvalExtensionPath;
      if (approvalExtensionPath === undefined) return { kind: "approval-gate-missing" };
      args.push("--extension", approvalExtensionPath);
      environment = { ...environment, T3_PI_APPROVAL_MODE: input.purpose.runtimeMode };
    }
  }
  for (const extensionPath of input.extensionPaths) args.push("--extension", extensionPath);
  return { kind: "ok", launch: { binaryPath, args, environment } };
}
