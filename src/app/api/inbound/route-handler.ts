import { RetryableInfrastructureError } from "../../../application/errors/infrastructure-error";
import { EventProcessingRejectedError } from "../../../application/errors/event-processing-error";
import type { InboundRequestVerifier } from "../../../application/ports/inbound-request-verifier";
import { MAX_INBOUND_BODY_BYTES } from "../../../application/security/technical-limits";
import type {
  IncomingPartnerEvent,
  ProcessIncomingEventResult,
} from "../../../application/workflows/process-incoming-event";
import { incomingPartnerEventSchema } from "../../../application/workflows/process-incoming-event";

export type InboundProcessor = (
  input: IncomingPartnerEvent,
) => Promise<ProcessIncomingEventResult>;

export interface InboundErrorResponse {
  ok: false;
  error: {
    code:
      | "INVALID_JSON"
      | "INVALID_INPUT"
      | "PAYLOAD_TOO_LARGE"
      | "UNSUPPORTED_MEDIA_TYPE"
      | "INBOUND_AUTH_NOT_CONFIGURED"
      | "UNAUTHORIZED"
      | "LLM_UNAVAILABLE"
      | "PROCESSING_REJECTED"
      | "PROCESSING_FAILED";
    message: string;
    retryable: boolean;
  };
}

export interface InboundSuccessResponse {
  ok: true;
  result: ProcessIncomingEventResult;
}

class PayloadTooLargeError extends Error {}

async function readBoundedBody(request: Request): Promise<Uint8Array> {
  const contentLength = request.headers.get("content-length");
  if (contentLength !== null) {
    const parsedLength = Number(contentLength);
    if (
      !Number.isSafeInteger(parsedLength) ||
      parsedLength < 0 ||
      parsedLength > MAX_INBOUND_BODY_BYTES
    ) {
      throw new PayloadTooLargeError();
    }
  }

  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > MAX_INBOUND_BODY_BYTES) {
        await reader.cancel();
        throw new PayloadTooLargeError();
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

function errorResponse(
  status: number,
  code: InboundErrorResponse["error"]["code"],
  message: string,
  retryable: boolean,
): Response {
  return Response.json(
    { ok: false, error: { code, message, retryable } } satisfies InboundErrorResponse,
    { status },
  );
}

export function createInboundPostHandler(
  processIncomingEvent: InboundProcessor,
  verifier: InboundRequestVerifier,
) {
  return async function POST(request: Request): Promise<Response> {
    const contentType = request.headers.get("content-type")?.toLowerCase() ?? "";
    if (!contentType.includes("application/json")) {
      return errorResponse(
        415,
        "UNSUPPORTED_MEDIA_TYPE",
        "Content-Type must be application/json",
        false,
      );
    }

    let rawBody: Uint8Array;
    try {
      rawBody = await readBoundedBody(request);
    } catch (error) {
      if (error instanceof PayloadTooLargeError) {
        return errorResponse(
          413,
          "PAYLOAD_TOO_LARGE",
          "Request body is too large",
          false,
        );
      }
      return errorResponse(400, "INVALID_JSON", "Request body is invalid", false);
    }

    let verification;
    try {
      verification = await verifier.verify({
        headers: request.headers,
        rawBody,
      });
    } catch {
      return errorResponse(
        503,
        "INBOUND_AUTH_NOT_CONFIGURED",
        "Inbound channel is not active",
        false,
      );
    }
    if (!verification.trusted) {
      return verification.reason === "AUTH_NOT_CONFIGURED"
        ? errorResponse(
            503,
            "INBOUND_AUTH_NOT_CONFIGURED",
            "Inbound channel is not active",
            false,
          )
        : errorResponse(401, "UNAUTHORIZED", "Unauthorized inbound request", false);
    }

    let body: unknown;
    try {
      body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(rawBody));
    } catch {
      return errorResponse(400, "INVALID_JSON", "Request body must be valid JSON", false);
    }

    const parsed = incomingPartnerEventSchema.safeParse(body);
    if (!parsed.success) {
      return errorResponse(
        400,
        "INVALID_INPUT",
        "Request body does not match the inbound event schema",
        false,
      );
    }

    try {
      const result = await processIncomingEvent(parsed.data);
      return Response.json(
        { ok: true, result } satisfies InboundSuccessResponse,
        { status: 200 },
      );
    } catch (error) {
      if (error instanceof RetryableInfrastructureError) {
        return errorResponse(
          503,
          "LLM_UNAVAILABLE",
          "Message was saved and can be retried",
          true,
        );
      }
      if (error instanceof EventProcessingRejectedError) {
        return errorResponse(
          422,
          "PROCESSING_REJECTED",
          "Saved event cannot be retried automatically",
          false,
        );
      }
      return errorResponse(
        500,
        "PROCESSING_FAILED",
        "Message processing failed after intake",
        false,
      );
    }
  };
}
