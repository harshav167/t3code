import type {
  ApprovalRequestId,
  CanonicalRequestType,
  PiSettings,
  ProviderApprovalDecision,
  ProviderInstanceId,
  ProviderRuntimeEvent,
  ProviderSendTurnInput,
  ProviderSession,
  ProviderSessionStartInput,
  ProviderUserInputAnswers,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import type * as Effect from "effect/Effect";
import type * as PlatformError from "effect/PlatformError";
import type * as Scope from "effect/Scope";
import type { ChildProcessSpawner } from "effect/unstable/process";

import type { ProviderAdapterError } from "../Errors.ts";
import type { PiToolItem } from "./PiTools.ts";
import type { MakePiRpcTransportOptions, PiRpcTransport } from "./PiRpcTransport.ts";

export interface PiPendingApproval {
  readonly piId: string;
  readonly requestType: CanonicalRequestType;
  readonly sessionApprovalKey: string;
}

export interface PiTurnState {
  readonly turnId: TurnId;
  readonly promptRequestId?: string;
  readonly items: Array<PiToolItem>;
}

export interface PiSessionModule {
  readonly start: Effect.Effect<ProviderSession, ProviderAdapterError>;
  readonly sendTurn: (
    input: ProviderSendTurnInput,
  ) => Effect.Effect<
    { threadId: ThreadId; turnId: TurnId; resumeCursor?: unknown },
    ProviderAdapterError
  >;
  readonly interruptTurn: Effect.Effect<void, ProviderAdapterError>;
  readonly respondToRequest: (
    requestId: ApprovalRequestId,
    decision: ProviderApprovalDecision,
  ) => Effect.Effect<void, ProviderAdapterError>;
  readonly respondToUserInput: (
    requestId: ApprovalRequestId,
    answers: ProviderUserInputAnswers,
  ) => Effect.Effect<void, ProviderAdapterError>;
  readonly readThread: Effect.Effect<
    {
      threadId: ThreadId;
      turns: ReadonlyArray<{ id: TurnId; items: ReadonlyArray<PiToolItem> }>;
    },
    ProviderAdapterError
  >;
  readonly rollbackThread: (numTurns: number) => Effect.Effect<
    {
      threadId: ThreadId;
      turns: ReadonlyArray<{ id: TurnId; items: ReadonlyArray<PiToolItem> }>;
    },
    ProviderAdapterError
  >;
  readonly stop: Effect.Effect<void, ProviderAdapterError>;
  readonly hasStopped: Effect.Effect<boolean>;
  readonly readSession: Effect.Effect<ProviderSession>;
}

export interface MakePiSessionOptions {
  readonly input: ProviderSessionStartInput;
  readonly settings: PiSettings;
  readonly instanceId: ProviderInstanceId;
  readonly environment: NodeJS.ProcessEnv;
  readonly approvalExtensionPath?: string;
  readonly makeTransport?: (
    options: MakePiRpcTransportOptions,
  ) => Effect.Effect<
    PiRpcTransport,
    PlatformError.PlatformError,
    Scope.Scope | ChildProcessSpawner.ChildProcessSpawner
  >;
  readonly emit: (event: ProviderRuntimeEvent) => Effect.Effect<void>;
  readonly onStopped: (threadId: ThreadId) => Effect.Effect<void>;
}
