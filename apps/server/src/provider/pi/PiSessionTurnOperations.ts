import { type ModelSelection, type ProviderSendTurnInput, TurnId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { resolveAttachmentPath } from "../../attachmentStore.ts";
import { ProviderAdapterRequestError, ProviderAdapterValidationError } from "../Errors.ts";
import {
  buildPiTurnCommand,
  piImageContentFromBytes,
  type PiImageContent,
  piPromptAgentInvoked,
  piResponseSucceeded,
  planPiModelSwitch,
  resolvePiThinkingLevel,
} from "./PiModels.ts";
import type { PiSessionOperationsOptions } from "./PiSessionOperations.ts";

const PROVIDER = "pi" as const;
const PROMPT_PREFLIGHT_TIMEOUT_MS = 5 * 60_000;

export function makePiSessionTurnOperations(options: PiSessionOperationsOptions) {
  const resolveImages = (attachments: ProviderSendTurnInput["attachments"]) =>
    Effect.forEach(attachments ?? [], (attachment) =>
      Effect.gen(function* () {
        const path = resolveAttachmentPath({ attachmentsDir: options.attachmentsDir, attachment });
        if (!path) {
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "prompt",
            detail: `Invalid attachment id '${attachment.id}'.`,
          });
        }
        const bytes = yield* options.fileSystem.readFile(path).pipe(
          Effect.mapError(
            (cause) =>
              new ProviderAdapterRequestError({
                provider: PROVIDER,
                method: "prompt",
                detail: `Failed to read attachment '${attachment.id}'.`,
                cause,
              }),
          ),
        );
        return piImageContentFromBytes({ mimeType: attachment.mimeType, bytes });
      }),
    );

  const prepareTurn = (input: ProviderSendTurnInput) =>
    options.serialize(
      Effect.gen(function* () {
        yield* options.failClosed();
        const text = typeof input.input === "string" ? input.input : "";
        const images: ReadonlyArray<PiImageContent> = yield* resolveImages(input.attachments);
        if (!text && images.length === 0) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "sendTurn",
            issue: "Pi turns require non-empty text or at least one attachment.",
          });
        }
        const midTurn = options.getTurn() !== undefined;
        if (!midTurn) {
          const requested =
            input.modelSelection?.instanceId === options.instanceId
              ? input.modelSelection.model
              : undefined;
          const plan = planPiModelSwitch(options.getCurrentModel(), requested);
          if (plan.kind === "invalid") {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "sendTurn",
              issue: `Invalid Pi model slug '${plan.slug}'; expected 'provider/id'.`,
            });
          }
          if (plan.kind === "switch") {
            const response = yield* options.request(
              { type: "set_model", provider: plan.provider, modelId: plan.modelId },
              5_000,
            );
            if (!piResponseSucceeded(response, "set_model")) {
              return yield* new ProviderAdapterRequestError({
                provider: PROVIDER,
                method: "set_model",
                detail: `Pi rejected model switch to '${plan.slug}'.`,
              });
            }
            options.setCurrentModel(plan.slug);
            options.setSession({ ...options.getSession(), model: plan.slug });
            options.setThinking(undefined);
          }
          const thinking = resolvePiThinkingLevel(
            input.modelSelection as ModelSelection | undefined,
          );
          if (thinking && thinking !== options.getThinking()) {
            const response = yield* options.request(
              { type: "set_thinking_level", level: thinking },
              5_000,
            );
            if (!piResponseSucceeded(response, "set_thinking_level")) {
              return yield* new ProviderAdapterRequestError({
                provider: PROVIDER,
                method: "set_thinking_level",
                detail: "Pi rejected the thinking level.",
              });
            }
            options.setThinking(thinking);
          }
        }
        const turnId = options.getTurn()?.turnId ?? TurnId.make(yield* options.nextUuid);
        const turnCommand = buildPiTurnCommand({ isMidTurn: midTurn, message: text, images });
        const promptRequestId = midTurn ? undefined : `pi-prompt-${yield* options.nextUuid}`;
        if (!midTurn) {
          options.setTurn({
            turnId,
            ...(promptRequestId ? { promptRequestId } : {}),
            items: [],
          });
          options.setSession({
            ...options.getSession(),
            status: "running",
            activeTurnId: turnId,
            updatedAt: yield* options.now,
          });
          yield* options.emit({
            type: "turn.started",
            turnId,
            payload: options.getCurrentModel() ? { model: options.getCurrentModel() } : {},
          });
        }
        return { midTurn, promptRequestId, turnCommand, turnId };
      }),
    );

  const completePreparedTurn = (
    turnId: TurnId,
    state: "completed" | "failed",
    errorMessage?: string,
  ) =>
    options.serialize(
      Effect.gen(function* () {
        if (options.getTurn()?.turnId === turnId) {
          yield* options.completeTurn(state, errorMessage);
        }
      }),
    );

  const stopPreparedTurn = (turnId: TurnId) =>
    options.serialize(
      Effect.gen(function* () {
        if (options.getTurn()?.turnId === turnId) yield* options.stopUnexpected;
      }),
    );

  const sendTurn = (input: ProviderSendTurnInput) =>
    Effect.gen(function* () {
      const prepared = yield* prepareTurn(input);
      const turnResponse = yield* options
        .request(
          prepared.turnCommand,
          prepared.midTurn ? 5_000 : PROMPT_PREFLIGHT_TIMEOUT_MS,
          prepared.promptRequestId,
        )
        .pipe(
          Effect.tapError((error) =>
            prepared.midTurn
              ? Effect.void
              : completePreparedTurn(prepared.turnId, "failed", error.message),
          ),
        );
      if (!turnResponse && !prepared.midTurn) {
        yield* stopPreparedTurn(prepared.turnId);
        return yield* new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: prepared.turnCommand.type,
          detail:
            "Pi prompt preflight timed out; the session was stopped to prevent an untracked run.",
        });
      }
      if (!piResponseSucceeded(turnResponse, prepared.turnCommand.type)) {
        const error = new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: prepared.turnCommand.type,
          detail: "The Pi runtime did not accept the message.",
        });
        if (!prepared.midTurn) {
          yield* completePreparedTurn(prepared.turnId, "failed", error.message);
        }
        return yield* error;
      }
      if (!prepared.midTurn && piPromptAgentInvoked(turnResponse) === false) {
        yield* completePreparedTurn(prepared.turnId, "completed");
      }
      const session = options.getSession();
      return {
        threadId: options.threadId,
        turnId: prepared.turnId,
        ...(session.resumeCursor !== undefined ? { resumeCursor: session.resumeCursor } : {}),
      };
    });

  return { sendTurn } as const;
}
