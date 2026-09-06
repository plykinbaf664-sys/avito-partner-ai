import { RetryableInfrastructureError } from "../../../application/errors/infrastructure-error";
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
    code: "INVALID_JSON" | "INVALID_INPUT" | "LLM_UNAVAILABLE" | "PROCESSING_FAILED";
    message: string;
    retryable: boolean;
  };
}

export interface InboundSuccessResponse {
  ok: true;
  result: ProcessIncomingEventResult;
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

export function createInboundPostHandler(processIncomingEvent: InboundProcessor) {
  return async function POST(request: Request): Promise<Response> {
    let body: unknown;
    try {
      body = await request.json();
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
      return errorResponse(
        500,
        "PROCESSING_FAILED",
        "Message processing failed after intake",
        true,
      );
    }
  };
}
