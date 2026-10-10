import type { OutboundDeliveryRequest } from "@/application/ports/channels";
import type { Persistence } from "@/application/ports/repositories";
import type { StructuredLogger } from "@/application/observability/structured-logger";
import { createIncomingEventAcceptor } from "@/application/workflows/accept-incoming-event";
import { createExternalConversationMessageRecorder } from "@/application/workflows/record-external-message";
import { persistIncomingEventContext } from "@/application/workflows/process-incoming-event";
import { outboundCancellationReason } from "@/application/delivery/outbound-obsolescence";
import { generateId } from "@/shared/id";
import { AvitoApiError, type AvitoApiClient } from "./avito-api-client";
import { AvitoInboundChannel } from "./avito-inbound-channel";

/** One authoritative history read, no LLM and no recursive processing. Fresh
 * customer events are durably queued for the ordinary polling/webhook worker. */
export async function refreshBeforeAvitoOutbound(client: AvitoApiClient, persistence: Persistence,
  request: OutboundDeliveryRequest, logger: StructuredLogger): Promise<string | null> {
  const draft = await persistence.messages.findByDeduplicationKey(request.idempotencyKey);
  if (!draft) throw new AvitoApiError("AVITO_OUTBOUND_DRAFT_NOT_FOUND", null, false);
  const account = await client.getAuthenticatedAccount();
  const history = await client.listMessages(request.externalRecipientId, { limit: 100, offset: 0 });
  const accept = createIncomingEventAcceptor({ persistence, logger });
  const recordHuman = createExternalConversationMessageRecorder({ persistence, logger });
  const channel = new AvitoInboundChannel();
  const existing = await persistence.messages.listByLeadId(draft.leadId);
  const currentInput = existing.filter(m => m.direction === "INBOUND" && m.createdAt <= draft.createdAt).at(-1);
  const since = currentInput?.createdAt.getTime() ?? draft.createdAt.getTime();
  for (const message of history.slice().sort((a, b) => a.createdAtUnix - b.createdAtUnix)) {
    if (message.origin !== "MESSAGE_HISTORY" || message.authorId === "0" || message.type !== "text" ||
        !message.text?.trim() || message.createdAtUnix * 1000 < since ||
        await persistence.messages.findByExternalMessageId(message.id)) continue;
    if (message.direction === "out" && message.authorId === account.id) {
      await recordHuman({ source: "AVITO", externalLeadId: request.externalRecipientId,
        externalMessageId: message.id, text: message.text.trim(), createdAt: new Date(message.createdAtUnix * 1000) });
    } else if (message.direction === "in" && message.authorId !== account.id) {
      const accepted = await accept(channel.fromVerifiedMessage(request.externalRecipientId, message));
      await persistence.transaction(repositories => persistIncomingEventContext(repositories, accepted.event,
        accepted.input, generateId, accepted.input.receivedAt!));
    }
  }
  return outboundCancellationReason(draft, await persistence.messages.listByLeadId(draft.leadId));
}
