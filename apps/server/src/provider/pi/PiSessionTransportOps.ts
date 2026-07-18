import type { ProviderDriverKind } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { ProviderAdapterRequestError } from "../Errors.ts";
import type { RpcCommand } from "./PiModels.ts";
import type { RpcExtensionUIResponse, RpcResponse } from "./PiRpcProtocol.ts";
import type { PiRpcTransport } from "./PiRpcTransport.ts";

export function makePiSessionTransportOps(options: {
  readonly provider: ProviderDriverKind;
  readonly nextUuid: Effect.Effect<string>;
  readonly getTransport: () => PiRpcTransport;
}) {
  const request = (
    command: RpcCommand,
    timeout: number,
    requestId?: string,
  ): Effect.Effect<RpcResponse | undefined, ProviderAdapterRequestError> =>
    Effect.gen(function* () {
      const id = requestId ?? `pi-${command.type}-${yield* options.nextUuid}`;
      return yield* options
        .getTransport()
        .request(command, id, timeout)
        .pipe(
          Effect.mapError(
            (cause) =>
              new ProviderAdapterRequestError({
                provider: options.provider,
                method: command.type,
                detail: cause.detail,
                cause,
              }),
          ),
        );
    });
  const writeExtension = (response: RpcExtensionUIResponse) =>
    options
      .getTransport()
      .writeExtensionResponse(response)
      .pipe(
        Effect.mapError(
          (cause) =>
            new ProviderAdapterRequestError({
              provider: options.provider,
              method: "extension_ui_response",
              detail: cause.detail,
              cause,
            }),
        ),
      );
  return { request, writeExtension } as const;
}
