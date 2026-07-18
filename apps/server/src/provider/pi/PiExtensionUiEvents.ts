import { ApprovalRequestId, RuntimeRequestId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import type { ProviderAdapterRequestError } from "../Errors.ts";
import { buildPiUserInputQuestion, type PendingUserInput } from "./PiExtensionUi.ts";
import type { RpcExtensionUIRequest, RpcExtensionUIResponse } from "./PiRpcProtocol.ts";
import type { PiSessionEvent } from "./PiSessionEvents.ts";
import type { PiPendingApproval, PiTurnState } from "./PiSessionTypes.ts";
import { classifyPiApprovalRequestType } from "./PiTools.ts";

export function handlePiExtensionUiRequest(
  options: {
    readonly nextRequestId: Effect.Effect<ApprovalRequestId>;
    readonly getTurn: () => PiTurnState | undefined;
    readonly pendingApprovals: Map<ApprovalRequestId, PiPendingApproval>;
    readonly pendingInputs: Map<ApprovalRequestId, PendingUserInput>;
    readonly sessionApprovals: Set<string>;
    readonly writeExtension: (
      response: RpcExtensionUIResponse,
    ) => Effect.Effect<void, ProviderAdapterRequestError>;
    readonly emit: (event: PiSessionEvent) => Effect.Effect<void>;
  },
  request: RpcExtensionUIRequest,
): Effect.Effect<void> {
  return Effect.gen(function* () {
    if (request.method === "cancel") {
      const approval = [...options.pendingApprovals].find(
        ([, pending]) => pending.piId === request.targetId,
      );
      if (approval !== undefined) {
        const [requestId, pending] = approval;
        options.pendingApprovals.delete(requestId);
        const turn = options.getTurn();
        yield* options.emit({
          type: "request.resolved",
          ...(turn ? { turnId: turn.turnId } : {}),
          requestId: RuntimeRequestId.make(requestId),
          payload: { requestType: pending.requestType, decision: "cancel" },
        });
        return;
      }
      const input = [...options.pendingInputs].find(
        ([, pending]) => pending.piId === request.targetId,
      );
      if (input !== undefined) {
        const [requestId] = input;
        options.pendingInputs.delete(requestId);
        const turn = options.getTurn();
        yield* options.emit({
          type: "user-input.resolved",
          ...(turn ? { turnId: turn.turnId } : {}),
          requestId: RuntimeRequestId.make(requestId),
          payload: { answers: {} },
        });
      }
      return;
    }
    if (
      request.method !== "confirm" &&
      request.method !== "select" &&
      request.method !== "input" &&
      request.method !== "editor"
    ) {
      return;
    }
    const requestId = yield* options.nextRequestId;
    const turn = options.getTurn();
    if (request.method === "confirm") {
      const requestType = classifyPiApprovalRequestType(request.title);
      const detail = request.message ? `${request.title}\n${request.message}` : request.title;
      const sessionApprovalKey = `${requestType}:${detail}`;
      if (options.sessionApprovals.has(sessionApprovalKey)) {
        const delivered = yield* options
          .writeExtension({ type: "extension_ui_response", id: request.id, confirmed: true })
          .pipe(
            Effect.as(true),
            Effect.orElseSucceed(() => false),
          );
        if (delivered) return;
      }
      options.pendingApprovals.set(requestId, {
        piId: request.id,
        requestType,
        sessionApprovalKey,
      });
      yield* options.emit({
        type: "request.opened",
        ...(turn ? { turnId: turn.turnId } : {}),
        requestId: RuntimeRequestId.make(requestId),
        payload: { requestType, detail: detail.slice(0, 2_000), args: request },
        raw: { source: "pi.rpc.extension-ui", method: request.method, payload: request },
      });
      return;
    }
    const questionId = String(requestId);
    const projected = buildPiUserInputQuestion({
      questionId,
      method: request.method,
      title: request.title,
      ...(request.method === "select" ? { options: request.options } : {}),
    });
    options.pendingInputs.set(requestId, {
      piId: request.id,
      questionId,
      method: request.method,
      ...(projected.numberedOptions ? { numberedOptions: projected.numberedOptions } : {}),
    });
    yield* options.emit({
      type: "user-input.requested",
      ...(turn ? { turnId: turn.turnId } : {}),
      requestId: RuntimeRequestId.make(requestId),
      payload: { questions: [projected.question] },
      raw: { source: "pi.rpc.extension-ui", method: request.method, payload: request },
    });
  });
}
