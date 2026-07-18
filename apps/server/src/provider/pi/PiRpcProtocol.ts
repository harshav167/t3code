import * as Cause from "effect/Cause";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import {
  PiControlFrameSchemas,
  PiEventSchemas,
  PiExtensionRequestSchemas,
} from "./PiRpcFrameSchemas.ts";
import {
  PiResponseEnvelope,
  PiUncorrelatedResponse,
  piResponseSchema,
} from "./PiRpcResponseSchemas.ts";
import type {
  AgentSessionEvent,
  PiControlFrame,
  RpcExtensionUIRequest,
  RpcResponse,
} from "./PiRpcTypes.ts";

export type {
  AgentSessionEvent,
  PiControlFrame,
  RpcExtensionUIRequest,
  RpcExtensionUIResponse,
  RpcResponse,
} from "./PiRpcTypes.ts";

export type PiStdoutMessage =
  | { readonly _tag: "response"; readonly id: string; readonly response: RpcResponse }
  | { readonly _tag: "extension-ui"; readonly request: RpcExtensionUIRequest }
  | { readonly _tag: "event"; readonly event: AgentSessionEvent }
  | { readonly _tag: "control"; readonly frame: PiControlFrame };

export type PiStdoutDecodeResult =
  | { readonly _tag: "Ignored" }
  | { readonly _tag: "Message"; readonly message: PiStdoutMessage }
  | { readonly _tag: "InvalidResponse"; readonly id: string; readonly error: string }
  | { readonly _tag: "InvalidExtensionUiRequest"; readonly id: string; readonly error: string }
  | { readonly _tag: "FatalProtocolError"; readonly error: string };

const JsonValue = Schema.UnknownFromJsonString;
const decodeJsonValue = Schema.decodeUnknownExit(JsonValue);
const decodeJsonObject = Schema.decodeUnknownOption(Schema.Record(Schema.String, Schema.Unknown));

function decodeError(schema: Schema.Top, value: unknown): string | null {
  const result = Schema.decodeUnknownExit(schema as Schema.Decoder<unknown, never>)(value);
  return Exit.isSuccess(result) ? null : Cause.pretty(result.cause);
}

export function decodePiStdoutLine(line: string): PiStdoutDecodeResult {
  const trimmed = line.trim();
  if (trimmed.length === 0 || !trimmed.startsWith("{")) return { _tag: "Ignored" };

  const json = decodeJsonValue(trimmed);
  if (Exit.isFailure(json)) return { _tag: "FatalProtocolError", error: Cause.pretty(json.cause) };
  const value = json.value;
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return { _tag: "FatalProtocolError", error: "Pi protocol frame must be a JSON object." };
  }
  const record = Option.getOrUndefined(decodeJsonObject(value));
  if (record === undefined) {
    return { _tag: "FatalProtocolError", error: "Pi protocol frame must be a JSON object." };
  }
  const type = record["type"];

  if (type === "response") {
    const id = record["id"];
    if (id === undefined) {
      const error = decodeError(PiUncorrelatedResponse, value);
      return error ? { _tag: "FatalProtocolError", error } : { _tag: "Ignored" };
    }
    if (typeof id !== "string") {
      return { _tag: "FatalProtocolError", error: "Pi response is missing a string id." };
    }
    const envelopeError = decodeError(PiResponseEnvelope, value);
    if (envelopeError) return { _tag: "InvalidResponse", id, error: envelopeError };
    const error = decodeError(
      piResponseSchema(String(record["command"]), record["success"] === true),
      value,
    );
    return error
      ? { _tag: "InvalidResponse", id, error }
      : { _tag: "Message", message: { _tag: "response", id, response: value as RpcResponse } };
  }

  if (type === "extension_ui_request") {
    const id = record["id"];
    if (typeof id !== "string") {
      return {
        _tag: "FatalProtocolError",
        error: "Pi extension UI request is missing a string id.",
      };
    }
    const method = record["method"];
    const schema =
      typeof method === "string"
        ? PiExtensionRequestSchemas[method as keyof typeof PiExtensionRequestSchemas]
        : undefined;
    if (!schema)
      return { _tag: "InvalidExtensionUiRequest", id, error: "Unknown extension UI method." };
    const error = decodeError(schema, value);
    return error
      ? { _tag: "InvalidExtensionUiRequest", id, error }
      : {
          _tag: "Message",
          message: { _tag: "extension-ui", request: value as RpcExtensionUIRequest },
        };
  }

  if (typeof type !== "string") {
    return { _tag: "FatalProtocolError", error: "Pi protocol frame is missing a type." };
  }
  const controlSchema = PiControlFrameSchemas[type as keyof typeof PiControlFrameSchemas];
  if (controlSchema) {
    const error = decodeError(controlSchema, value);
    return error
      ? { _tag: "FatalProtocolError", error }
      : { _tag: "Message", message: { _tag: "control", frame: value as PiControlFrame } };
  }
  const schema = PiEventSchemas[type as keyof typeof PiEventSchemas];
  if (!schema) return { _tag: "Ignored" };
  const error = decodeError(schema, value);
  return error
    ? { _tag: "FatalProtocolError", error }
    : { _tag: "Message", message: { _tag: "event", event: value as AgentSessionEvent } };
}
