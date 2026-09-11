import type { IncomingEvent } from "@/domain/event/incoming-event";
import { generateId, type IdGenerator } from "@/shared/id";

import {
  incomingPartnerEventSchema,
  type IncomingPartnerEvent,
} from "./process-incoming-event";
import type { Persistence } from "../ports/repositories";
import {
  silentLogger,
  type StructuredLogger,
} from "../observability/structured-logger";

export interface AcceptedIncomingEvent {
  event: IncomingEvent;
  input: IncomingPartnerEvent;
  created: boolean;
  shouldProcess: boolean;
}

export function createIncomingEventAcceptor({
  persistence,
  logger = silentLogger,
  generateId: idGenerator = generateId,
  now: clock = () => new Date(),
}: {
  persistence: Persistence;
  logger?: StructuredLogger;
  generateId?: IdGenerator;
  now?: () => Date;
}) {
  return async function acceptIncomingEvent(
    untrustedInput: IncomingPartnerEvent,
  ): Promise<AcceptedIncomingEvent> {
    const input = incomingPartnerEventSchema.parse(untrustedInput);
    const receivedAt = input.receivedAt ?? clock();
    const storedInput = {
      source: input.source,
      externalEventId: input.externalEventId,
      externalLeadId: input.externalLeadId,
      messageId: input.messageId,
      text: input.text,
      receivedAt: receivedAt.toISOString(),
    };
    const registration = await persistence.incomingEvents.register({
      id: idGenerator(),
      source: input.source,
      externalEventId: input.externalEventId,
      externalLeadId: input.externalLeadId,
      payload: { normalizedInput: storedInput },
      status: "RECEIVED",
      error: null,
      processingAttempts: 0,
      processingRetryable: null,
      extraction: null,
      llmModel: null,
      llmInputTokens: null,
      llmOutputTokens: null,
      llmLatencyMs: null,
      totalProcessingLatencyMs: null,
      receivedAt,
      processingStartedAt: null,
      processedAt: null,
    });
    logger.info(registration.created ? "event.accepted" : "event.duplicate", {
      eventId: registration.event.id,
      leadId: null,
      conversationId: null,
      source: input.source,
    });
    return {
      event: registration.event,
      input: { ...input, receivedAt },
      created: registration.created,
      shouldProcess:
        registration.event.status === "RECEIVED" ||
        (registration.event.status === "FAILED" &&
          registration.event.processingRetryable !== false),
    };
  };
}

