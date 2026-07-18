import {
  ProviderDriverKind,
  type ProviderInstanceId,
  type ProviderSession,
  type ProviderSessionStartInput,
} from "@t3tools/contracts";

export function makeInitialPiSessionState(options: {
  readonly input: ProviderSessionStartInput;
  readonly instanceId: ProviderInstanceId;
  readonly model: string | undefined;
  readonly createdAt: string;
}): ProviderSession {
  return {
    threadId: options.input.threadId,
    provider: ProviderDriverKind.make("pi"),
    providerInstanceId: options.instanceId,
    status: "ready",
    runtimeMode: options.input.runtimeMode,
    ...(options.input.cwd !== undefined ? { cwd: options.input.cwd } : {}),
    ...(options.model !== undefined ? { model: options.model } : {}),
    createdAt: options.createdAt,
    updatedAt: options.createdAt,
  };
}
