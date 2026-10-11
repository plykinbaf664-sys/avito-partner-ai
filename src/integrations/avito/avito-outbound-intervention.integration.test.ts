import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { SqlitePersistence } from "@/infrastructure/database/sqlite-persistence";
import { createInitialLead, ensureIncomingConversation } from "@/application/workflows/process-incoming-event";
import { generateId } from "@/shared/id";
import type { Conversation } from "@/domain/conversation/conversation";
import type { Message } from "@/domain/message/message";
import { createOutboundMessageDelivery } from "@/application/delivery/deliver-outbound-message";
import { AvitoOutboundMessageProvider } from "./avito-outbound-message-provider";
import { AvitoApiError, type AvitoApiClient, type AvitoMessage } from "./avito-api-client";

describe("fresh Avito history before outbound", () => {
  it.each(["MANAGER_MEDIA", "USER_MEDIA", "EMPTY"] as const)("fences a proactive first contact against any pre-existing human activity: %s", async kind => {
    const persistence = await SqlitePersistence.createMigrated("file::memory:");
    try {
      const at = new Date("2026-10-11T10:00:00Z");
      const { lead, conversation } = await persistence.transaction(r => ensureIncomingConversation(r,
        { source: "AVITO", externalLeadId: "chat" }, generateId, at, { hasInbound: false }));
      const draft: Message = { id: "opening", conversationId: conversation.id, leadId: lead.id,
        incomingEventId: null, externalMessageId: null, deduplicationKey: `chat-opening:${conversation.id}`, sequence: null,
        direction: "OUTBOUND", actor: "AI", content: "Hello", deliveryStatus: "PENDING", deliveryAttempts: 0,
        deliveryRetryable: null, lastDeliveryErrorCode: null, sentAt: null, createdAt: at };
      await persistence.messages.insert(draft);
      const history: AvitoMessage[] = kind === "EMPTY" ? [] : [{ id: "older-human", authorId: kind === "MANAGER_MEDIA" ? "owner" : "customer",
        direction: kind === "MANAGER_MEDIA" ? "out" : "in", type: "image", text: null,
        createdAtUnix: at.getTime()/1000-60, origin: "MESSAGE_HISTORY" }];
      const client = { getAuthenticatedAccount: vi.fn().mockResolvedValue({ id: "owner" }),
        listMessages: vi.fn().mockResolvedValue(history), sendTextMessage: vi.fn().mockResolvedValue("sent") };
      const provider = new AvitoOutboundMessageProvider(client as unknown as AvitoApiClient, undefined, undefined, persistence);
      const result = await createOutboundMessageDelivery({ persistence, provider })(draft.id);
      if (kind === "EMPTY") {
        expect(client.sendTextMessage).toHaveBeenCalledTimes(1); expect(result.deliveryStatus).toBe("SENT");
      } else {
        expect(client.sendTextMessage).not.toHaveBeenCalled();
        expect(result).toMatchObject({ deliveryRetryable: false, lastDeliveryErrorCode: "CANCELLED_BY_EXISTING_DIALOGUE" });
      }
    } finally { persistence.close(); }
  });
  it.each(["MANAGER", "USER", "UNCHANGED", "UNAVAILABLE"] as const)("checks fresh history before sending: %s", async actor => {
    const persistence = await SqlitePersistence.createMigrated("file::memory:", resolve(process.cwd(), "drizzle"));
    try {
      const at = new Date("2026-10-11T10:00:00Z");
      const lead = createInitialLead("lead", "AVITO", "chat", at);
      await persistence.leads.insert(lead);
      const conversation: Conversation = { id: "conversation", leadId: lead.id, state: "QUALIFYING", summary: null,
        pendingInformationNeed: null, lastInboundAt: at, lastOutboundAt: null, awaitingUserReply: false,
        qualificationCompleted: false, followUpEligibleAt: null, followUpCount: 0, lastFollowUpAt: null,
        followUpAnchorAt: null, missedAt: null, nextInboundSequence: 1, lastAppliedInboundSequence: 1,
        createdAt: at, updatedAt: at, closedAt: null };
      await persistence.conversations.insert(conversation);
      const base: Message = { id: "inbound", conversationId: conversation.id, leadId: lead.id,
        incomingEventId: null, externalMessageId: "old-user", deduplicationKey: null, sequence: 1,
        direction: "INBOUND", actor: "USER", content: "Как начать?", deliveryStatus: null,
        deliveryAttempts: 0, deliveryRetryable: null, lastDeliveryErrorCode: null, sentAt: null, createdAt: at };
      await persistence.messages.insert(base);
      await persistence.messages.insert({ ...base, id: "draft", direction: "OUTBOUND", actor: "AI",
        externalMessageId: null, sequence: null, deduplicationKey: "turn-response:conversation:1",
        deliveryStatus: "PENDING", createdAt: new Date(at.getTime() + 2000) });
      const incoming: AvitoMessage = { id: "fresh", authorId: actor === "MANAGER" ? "owner" : "customer",
        direction: actor === "MANAGER" ? "out" : "in", type: "text", text: "Новый шаг разговора",
        createdAtUnix: at.getTime() / 1000 + 1, origin: "MESSAGE_HISTORY" };
      if (actor === "UNCHANGED") Object.assign(incoming, { id: "old-user", createdAtUnix: at.getTime() / 1000 });
      const client = { getAuthenticatedAccount: vi.fn().mockResolvedValue({ id: "owner" }),
        listMessages: vi.fn().mockResolvedValue([incoming]), sendTextMessage: vi.fn().mockResolvedValue("sent") };
      if (actor === "UNAVAILABLE") client.listMessages.mockRejectedValue(new AvitoApiError("AVITO_NETWORK_ERROR", null, true));
      const provider = new AvitoOutboundMessageProvider(client as unknown as AvitoApiClient, undefined, undefined, persistence);
      const result = await createOutboundMessageDelivery({ persistence, provider })("draft");
      if (actor === "UNCHANGED") {
        expect(client.sendTextMessage).toHaveBeenCalledExactlyOnceWith("chat", base.content);
        expect(result).toMatchObject({ deliveryStatus: "SENT", deliveryAttempts: 1 });
        return;
      }
      expect(client.sendTextMessage).not.toHaveBeenCalled();
      if (actor === "UNAVAILABLE") {
        expect(result).toMatchObject({ deliveryStatus: "FAILED", deliveryRetryable: true, lastDeliveryErrorCode: "AVITO_NETWORK_ERROR" });
        expect(await persistence.incomingEvents.findByIdentity("AVITO", "fresh")).toBeNull();
        return;
      }
      expect(result).toMatchObject({ deliveryStatus: "FAILED", deliveryRetryable: false,
        lastDeliveryErrorCode: actor === "MANAGER" ? "CANCELLED_BY_HUMAN_MESSAGE" : "CANCELLED_BY_INBOUND" });
      expect((await persistence.messages.listByConversationId(conversation.id)).some(m => m.externalMessageId === "fresh")).toBe(true);
      if (actor === "USER") expect(await persistence.incomingEvents.findByIdentity("AVITO", "fresh"))
        .toMatchObject({ status: "RECEIVED", processingAttempts: 0 });
    } finally { persistence.close(); }
  });
});
