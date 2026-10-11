import type { AvitoChat, AvitoMessage } from "@/integrations/avito/avito-api-client";
import type { Message } from "@/domain/message/message";
import type { ConversationResponsePlan } from "@/domain/conversation/conversation-response";
import { PARTNER_KNOWLEDGE_BASE } from "@/domain/knowledge/knowledge-base";
import { FOLLOW_UP_POLICY } from "@/domain/follow-up/follow-up-policy";
import { generateId } from "@/shared/id";
import type { Persistence } from "../ports/repositories";
import type { PollingStateRepository } from "../ports/polling-state";
import type { ChatOpening } from "../ports/chat-openings";
import type { OutboundMessageProvider } from "../ports/channels";
import type { NaturalResponseGenerator } from "../conversation/generate-natural-response";
import { mergeConversationalNotes } from "../conversation/conversation-context";
import { createOutboundMessageDelivery } from "../delivery/deliver-outbound-message";
import { externalErrorCode } from "../delivery/retry-policy";
import { settleLlmUsage, type LlmUsageTotals } from "../observability/llm-usage";
import { silentLogger, type StructuredLogger } from "../observability/structured-logger";
import { ensureIncomingConversation } from "./process-incoming-event";

export const CHAT_OPENING_DELAY_MS = 2 * 60_000;
const MAX_AGE_MS = 24 * 3600_000;
const RETRY_MS = 5 * 60_000;
const LEASE_MS = 10 * 60_000;

export function buildChatOpeningPlan(): ConversationResponsePlan {
  const facts = PARTNER_KNOWLEDGE_BASE.filter(entry => entry.id === "offer-overview");
  return { text: "Prepare an honest first contact about our listing; the customer has not spoken.",
    nextInformationNeed: null, asksUserQuestion: false, knowledgeEntryIds: facts.map(f => f.id),
    approvedFacts: facts.map(({ id, category, answer }) => ({ id, category, answer })),
    unresolvedQuestions: [], useNaturalAdaptation: true, greetingRequired: true, initialContact: true, preferDiscoveryContext: true,
    allowedNextInformationNeeds: [], allowedNextQuestions: [], allowedQualificationMoves: [],
    knownFacts: [], missingCriticalFacts: [], missingOptionalFacts: [], qualificationReasonCodes: [],
    currentUserQuestions: [], currentTurnRequiresAnswer: false, qualificationProgressExpected: false };
}

export function isServiceOnlyHistory(history: AvitoMessage[]): boolean {
  // Exactly 100 items may conceal older human activity. Unsupported human
  // media still counts as activity; service text is never matched by wording.
  return history.length <= 10 && history.every(message =>
    message.origin === "MESSAGE_HISTORY" && (message.authorId === "0" || message.type === "system"));
}

export function createChatOpeningWorkflow({ persistence, stateRepository, readHistory, generateNaturalResponse,
  outboundProvider, logger = silentLogger, clock = () => new Date(),
}: { persistence: Persistence; stateRepository: PollingStateRepository;
  readHistory: (chatId: string) => Promise<AvitoMessage[]>; generateNaturalResponse: NaturalResponseGenerator;
  outboundProvider: OutboundMessageProvider; logger?: StructuredLogger; clock?: () => Date }) {
  let activation: Date | null = null;
  const owner = generateId();
  const deliver = createOutboundMessageDelivery({ persistence, provider: outboundProvider, logger, now: clock });
  const finish = async (job: ChatOpening, reason: string) => {
    await persistence.transaction(async repositories => {
      if ((await repositories.chatOpenings.find(job.conversationId))?.leaseOwner !== owner) return;
      if (reason !== "SENT") {
        const draft = await repositories.messages.findByDeduplicationKey(`chat-opening:${job.conversationId}`);
        if (draft && draft.deliveryStatus !== "SENT" && draft.deliveryRetryable !== false) await repositories.messages.update({ ...draft,
          deliveryStatus: "FAILED", deliveryRetryable: false, lastDeliveryErrorCode: "CANCELLED_CHAT_OPENING" });
      }
      await repositories.chatOpenings.updateOwned({ ...job, status: "DONE", reason, leaseOwner: null, leaseUntil: null }, owner);
    });
    logger.info("chat_opening.completed", { conversationId: job.conversationId, reason, attempts: job.attempts });
  };
  const locallyUntouched = async (conversationId: string, draftId?: string) => {
    const conversation = await persistence.conversations.findById(conversationId);
    const history = await persistence.messages.listByConversationId(conversationId);
    return conversation !== null && !conversation.closedAt && conversation.nextInboundSequence === 0 &&
      history.every(message => message.id === draftId);
  };
  return {
    async start(accountId: string, now: Date) {
      activation = (await stateRepository.initialize(`avito-chat-openings:${accountId}`, now)).startedAt;
    },
    async observe(chat: AvitoChat, accountId: string, now: Date) {
      if (!activation || chat.createdAtUnix === undefined || chat.contextType !== "item" ||
        chat.listingOwnerId !== accountId || !chat.participantIds?.includes(accountId) ||
        !chat.participantIds.some(id => id !== accountId && id !== "0") ||
        chat.createdAtUnix * 1000 < activation.getTime() || chat.createdAtUnix * 1000 > now.getTime() ||
        now.getTime() - chat.createdAtUnix * 1000 > MAX_AGE_MS ||
        chat.lastMessage && chat.lastMessage.authorId !== "0" && chat.lastMessage.type !== "system") return;
      await persistence.transaction(async repositories => {
        const { lead, conversation } = await ensureIncomingConversation(repositories,
          { source: "AVITO", externalLeadId: chat.id }, generateId, now, { hasInbound: false });
        await repositories.chatOpenings.insertIfAbsent({ conversationId: conversation.id, leadId: lead.id,
          chatCreatedAt: new Date(chat.createdAtUnix! * 1000), eligibleAt: new Date(now.getTime() + CHAT_OPENING_DELAY_MS),
          status: "WAITING", attempts: 0, leaseOwner: null, leaseUntil: null, reason: null, response: null });
      });
    },
    async processDue(now: Date, assertLease: () => Promise<void> = async () => {}) {
      // Inbound processing happens first. Bound proactive work per polling cycle.
      for (const candidate of await persistence.chatOpenings.listDue(now, 2)) {
        await assertLease();
        let job = await persistence.chatOpenings.claim(candidate.conversationId, owner, clock(),
          new Date(clock().getTime() + LEASE_MS));
        if (!job) continue;
        let usage: LlmUsageTotals | undefined;
        const settle = (outcome: Parameters<typeof settleLlmUsage>[2]) => settleLlmUsage(persistence.llmUsage,
          usage?.callIds ?? [], outcome, () => logger.error("llm.usage_settlement_failed", { conversationId: job!.conversationId }));
        try {
          const conversation = await persistence.conversations.findById(job.conversationId);
          const lead = conversation && await persistence.leads.findById(conversation.leadId);
          if (!conversation || !lead) { await finish(job, "MISSING_CONTEXT"); continue; }
          const deduplicationKey = `chat-opening:${conversation.id}`;
          let draft = await persistence.messages.findByDeduplicationKey(deduplicationKey);
          // Recover a completed send before checking expiry or the retry ceiling.
          if (draft?.deliveryStatus !== "SENT") {
            if (job.attempts > 3 || now.getTime() - job.chatCreatedAt.getTime() > MAX_AGE_MS) {
              if (draft) await persistence.messages.update({ ...draft, deliveryStatus: "FAILED", deliveryRetryable: false,
                lastDeliveryErrorCode: "CANCELLED_CHAT_OPENING_EXPIRED" });
              await finish(job, "EXPIRED"); continue;
            }
            if (!await locallyUntouched(conversation.id, draft?.id)) { await finish(job, "HUMAN_ACTIVITY"); continue; }
            const history = await readHistory(lead.externalLeadId);
            if (!isServiceOnlyHistory(history)) { await finish(job, "HUMAN_ACTIVITY_OR_INCOMPLETE_HISTORY"); continue; }
            if (!draft) {
              const natural = await generateNaturalResponse({ lead, plan: buildChatOpeningPlan(), recentMessages: [],
                triggerType: "CHAT_OPENED", serviceObservations: history.slice().sort((a, b) => a.createdAtUnix - b.createdAtUnix)
                  .map(m => (m.text ?? "").slice(0, 2000)),
                llmContext: { requestId: generateId(), conversationId: conversation.id, leadId: lead.id,
                  source: "AVITO", operation: "CHAT_OPENING" } });
              usage = natural.llmUsage;
              if (natural.replyAction === "NO_REPLY") { await settle("NO_REPLY"); await finish(job, "NO_REPLY"); continue; }
              if (!natural.text.trim()) throw Object.assign(new Error("EMPTY_CHAT_OPENING"), { code: "EMPTY_CHAT_OPENING" });
              await assertLease();
              if (!isServiceOnlyHistory(await readHistory(lead.externalLeadId))) {
                await settle("SUPPRESSED"); await finish(job, "HUMAN_ACTIVITY_DURING_GENERATION"); continue;
              }
              job = { ...job, response: { awaitingUserReply: natural.awaitingUserReply ?? true,
                nextInformationNeed: natural.nextInformationNeed, notes: natural.conversationMemory } };
              const preparedJob = job;
              draft = await persistence.transaction(async repositories => {
                const owned = await repositories.chatOpenings.find(conversation.id);
                const current = await repositories.conversations.findById(conversation.id);
                if (owned?.leaseOwner !== owner || !owned.leaseUntil || owned.leaseUntil <= clock() ||
                  !current || current.closedAt || current.nextInboundSequence !== 0 ||
                  (await repositories.messages.listByConversationId(conversation.id)).length > 0) return null;
                await repositories.chatOpenings.updateOwned(preparedJob, owner);
                const message: Message = { id: generateId(), conversationId: conversation.id, leadId: lead.id,
                  incomingEventId: null, externalMessageId: null, deduplicationKey, sequence: null,
                  direction: "OUTBOUND", actor: "AI", content: natural.text, deliveryStatus: "PENDING",
                  deliveryAttempts: 0, deliveryRetryable: null, lastDeliveryErrorCode: null, sentAt: null, createdAt: clock() };
                return await repositories.messages.insertIfAbsent(message) ? message : null;
              });
              if (!draft) { await settle("SUPPRESSED"); await finish(job, "INTERVENING_ACTIVITY"); continue; }
            }
            await assertLease();
            draft = await deliver(draft.id);
          }
          if (draft.deliveryStatus === "SENT") {
            await persistence.transaction(async repositories => {
              const current = await repositories.conversations.findById(conversation.id);
              const history = await repositories.messages.listByConversationId(conversation.id);
              if (current && !current.closedAt && current.nextInboundSequence === 0 && history.every(m => m.id === draft!.id)) {
                const sentAt = draft!.sentAt ?? now;
                await repositories.conversations.update({ ...current, lastOutboundAt: sentAt,
                  summary: mergeConversationalNotes(current.summary, job!.response?.notes),
                  pendingInformationNeed: job!.response?.nextInformationNeed ?? null,
                  awaitingUserReply: job!.response?.awaitingUserReply ?? true, followUpAnchorAt: sentAt,
                  followUpEligibleAt: job!.response?.awaitingUserReply === false ? null : new Date(sentAt.getTime() + FOLLOW_UP_POLICY.delayMs),
                  followUpCount: 0, lastFollowUpAt: null, missedAt: null, updatedAt: clock() });
              }
            });
            await settle("USED"); await finish(job, "SENT");
          } else if (draft.deliveryRetryable === false || draft.deliveryAttempts >= 3) {
            await settle("SUPPRESSED"); await finish(job, draft.lastDeliveryErrorCode ?? "DELIVERY_FAILED");
          } else {
            await settle("USED");
            await persistence.chatOpenings.updateOwned({ ...job, status: "WAITING", leaseOwner: null, leaseUntil: null,
              eligibleAt: new Date(clock().getTime() + RETRY_MS), reason: "DELIVERY_RETRY" }, owner);
          }
        } catch (error) {
          if (error instanceof Error && "llmUsage" in error) usage = error.llmUsage as LlmUsageTotals;
          await settle("FAILED");
          logger.error("chat_opening.failed", { conversationId: job.conversationId, errorCode: externalErrorCode(error), attempts: job.attempts });
          if (job.attempts >= 3) await finish(job, "FAILED");
          else await persistence.chatOpenings.updateOwned({ ...job, status: "WAITING", leaseOwner: null, leaseUntil: null,
            eligibleAt: new Date(clock().getTime() + RETRY_MS), reason: "RETRY" }, owner);
        }
      }
    },
  };
}
