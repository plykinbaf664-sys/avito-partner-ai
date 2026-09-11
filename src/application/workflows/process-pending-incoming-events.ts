import { z } from "zod";

import type { Persistence } from "../ports/repositories";
import { MAX_INCOMING_PROCESSING_ATTEMPTS } from "../security/technical-limits";
import type { IncomingPartnerEvent } from "./process-incoming-event";

const storedInputSchema = z.object({
  normalizedInput: z.object({
    source: z.string(),
    externalEventId: z.string(),
    externalLeadId: z.string(),
    messageId: z.string(),
    text: z.string(),
    receivedAt: z.iso.datetime(),
  }),
});

export function createPendingIncomingEventProcessor({
  persistence,
  processIncomingEvent,
  now: clock = () => new Date(),
  staleAfterMs = 5 * 60_000,
}: {
  persistence: Persistence;
  processIncomingEvent: (input: IncomingPartnerEvent) => Promise<unknown>;
  now?: () => Date;
  staleAfterMs?: number;
}) {
  return async function processPendingIncomingEvents(limit = 25): Promise<{
    processed: number;
    failed: number;
    skipped: number;
  }> {
    const now = clock();
    const events = await persistence.incomingEvents.listRecoverable(
      now,
      new Date(now.getTime() - staleAfterMs),
      MAX_INCOMING_PROCESSING_ATTEMPTS,
      limit,
    );
    let processed = 0;
    let failed = 0;
    let skipped = 0;
    for (const event of events) {
      const stored = storedInputSchema.safeParse(event.payload);
      if (!stored.success) {
        skipped += 1;
        continue;
      }
      try {
        await processIncomingEvent({
          ...stored.data.normalizedInput,
          receivedAt: new Date(stored.data.normalizedInput.receivedAt),
        });
        processed += 1;
      } catch {
        failed += 1;
      }
    }
    return { processed, failed, skipped };
  };
}
