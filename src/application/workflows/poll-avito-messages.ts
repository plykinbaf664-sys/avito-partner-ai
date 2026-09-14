import { z } from "zod";

import type { PollingStateRepository } from "../ports/polling-state";
import type { Persistence } from "../ports/repositories";
import { silentLogger, type StructuredLogger } from "../observability/structured-logger";
import { MAX_INCOMING_PROCESSING_ATTEMPTS } from "../security/technical-limits";
import { createIncomingEventAcceptor } from "./accept-incoming-event";
import { incomingPartnerEventSchema, type IncomingPartnerEvent, type ProcessIncomingEventResult } from "./process-incoming-event";
import { AvitoApiError, type AvitoApiClient, type AvitoMessage } from "@/integrations/avito/avito-api-client";
import { AvitoInboundChannel } from "@/integrations/avito/avito-inbound-channel";
import { generateId } from "@/shared/id";

const PAGE_SIZE = 100;
const MAX_OFFSET = 1_000;
const OVERLAP_MS = 5 * 60_000;
const LEASE_MS = 10 * 60_000;
const STALE_EVENT_MS = 5 * 60_000;
const storedInputSchema = z.object({ normalizedInput: z.object({
  source: z.literal("AVITO"), externalEventId: z.string(), externalLeadId: z.string(),
  messageId: z.string(), text: z.string(), receivedAt: z.iso.datetime(),
}) });

export interface AvitoPollResult {
  status: "PASS" | "FAIL" | "BUSY";
  chats: number;
  checkedChats: number;
  skippedOldChats: number;
  historyErrors: number;
  previewAccepted: number;
  fetched: number;
  accepted: number;
  processed: number;
  duplicates: number;
  ignored: number;
  failed: number;
  apiRequests: number;
  durationMs: number;
}

export function createAvitoMessagePoller({
  client, persistence, stateRepository, processIncomingEvent,
  chatId: requestedChatId,
  logger = silentLogger, clock = () => new Date(),
}: {
  client: Pick<AvitoApiClient, "getAuthenticatedAccount" | "listChats" | "listMessages">;
  persistence: Persistence;
  stateRepository: PollingStateRepository;
  processIncomingEvent: (input: IncomingPartnerEvent) => Promise<ProcessIncomingEventResult>;
  chatId?: string;
  logger?: StructuredLogger;
  clock?: () => Date;
}) {
  const chatId = requestedChatId === undefined ? undefined : z.string().trim().min(1).max(255).parse(requestedChatId);
  const accept = createIncomingEventAcceptor({ persistence, logger, now: clock });
  const channel = new AvitoInboundChannel();

  return async function pollAvitoMessages(now: Date): Promise<AvitoPollResult> {
    if (!Number.isFinite(now.getTime())) throw new Error("INVALID_POLL_TIME");
    const started = performance.now();
    const result: AvitoPollResult = { status: "PASS", chats: 0, checkedChats: 0,
      skippedOldChats: 0, historyErrors: 0, previewAccepted: 0, fetched: 0,
      accepted: 0, processed: 0, duplicates: 0, ignored: 0, failed: 0,
      apiRequests: 0, durationMs: 0 };
    let key: string | null = null;
    let acquired = false;
    const owner = generateId();
    const assertLease = async () => {
      const at = clock();
      if (!key || !await stateRepository.renew(key, owner, at, new Date(at.getTime() + LEASE_MS))) {
        throw new Error("AVITO_POLL_LEASE_LOST");
      }
    };
    const attempted = new Set<string>();
    const processOne = async (input: IncomingPartnerEvent) => {
      if (attempted.has(input.externalEventId)) return;
      attempted.add(input.externalEventId);
      await assertLease();
      try {
        const processed = await processIncomingEvent(input);
        if (processed.duplicate) result.duplicates += 1;
        else result.processed += 1;
        logger.info("avito.poll.message", {
          source: "AVITO", externalEventId: input.externalEventId,
          eventId: processed.eventId, leadId: processed.leadId,
          conversationId: processed.conversationId, eventStatus: processed.eventStatus,
          duplicate: processed.duplicate,
        });
      } catch {
        result.failed += 1;
        logger.error("avito.poll.processing_failed", {
          source: "AVITO", externalEventId: input.externalEventId,
        });
      }
    };

    try {
      const account = await client.getAuthenticatedAccount();
      key = `avito-messages:${account.id}${chatId ? `:chat:${chatId}` : ""}`;
      await stateRepository.initialize(key, new Date(Math.floor(now.getTime() / 1_000) * 1_000));
      const at = clock();
      acquired = await stateRepository.acquire(key, owner, at, new Date(at.getTime() + LEASE_MS));
      if (!acquired) {
        result.status = "BUSY";
        return result;
      }
      // Reload only after acquiring the lease: another poll may have just completed.
      const state = await stateRepository.initialize(key, now);
      const since = Math.max(state.startedAt.getTime(),
        (state.lastCompletedAt?.getTime() ?? state.startedAt.getTime()) - OVERLAP_MS);
      logger.info("avito.poll.window", { source: "AVITO", accountId: account.id,
        chatId: chatId ?? null,
        startedAt: state.startedAt.toISOString(),
        lastCompletedAt: state.lastCompletedAt?.toISOString() ?? null,
        since: new Date(since).toISOString(), now: now.toISOString() });

      // Recovery uses durable input even if Avito no longer returns that message.
      const pending = await persistence.incomingEvents.listRecoverable(
        now, new Date(clock().getTime() - STALE_EVENT_MS), MAX_INCOMING_PROCESSING_ATTEMPTS, 100, "AVITO",
      );
      for (const event of pending) {
        const stored = storedInputSchema.safeParse(event.payload);
        if (stored.success && (!chatId || stored.data.normalizedInput.externalLeadId === chatId)) {
          await processOne({ ...stored.data.normalizedInput,
            receivedAt: new Date(stored.data.normalizedInput.receivedAt) });
        }
      }

      const seenChats = new Set<string>();
      let chatsComplete = false;
      for (let offset = 0; offset <= MAX_OFFSET; offset += PAGE_SIZE) {
        await assertLease();
        result.apiRequests += 1;
        const chats = await client.listChats({ unreadOnly: false, limit: PAGE_SIZE, offset });
        for (const chat of chats) {
          if (seenChats.has(chat.id)) continue;
          seenChats.add(chat.id);
          result.chats += 1;
          if (chatId && chat.id !== chatId) continue;
          // Never stop chat pagination based on ordering of the chat list.
          const latestTime = Math.max(chat.updatedAtUnix ?? 0, chat.lastMessage?.createdAtUnix ?? 0);
          if (latestTime > 0 && latestTime * 1_000 < since) {
            result.skippedOldChats += 1;
            continue;
          }
          result.checkedChats += 1;
          const messages = new Map<string, AvitoMessage>();
          const considerMessage = (message: AvitoMessage) => {
            if (message.createdAtUnix * 1_000 < since || message.direction !== "in" ||
                message.authorId === account.id || message.authorId === "0" || message.type === "system") {
              result.ignored += 1;
              return;
            }
            if (message.type !== "text" || !message.text?.trim()) {
              result.ignored += 1;
              logger.info("avito.poll.unsupported_message", {
                source: "AVITO", externalEventId: message.id, messageType: message.type,
              });
              return;
            }
            if (messages.has(message.id)) result.duplicates += 1;
            messages.set(message.id, message);
          };
          // The authenticated chat-list response contains a complete last_message.
          // Keep it even when the separate history endpoint is unavailable.
          if (chat.lastMessage) {
            result.fetched += 1;
            considerMessage(chat.lastMessage);
          }
          let messagesComplete = false;
          try {
            for (let messageOffset = 0; messageOffset <= MAX_OFFSET; messageOffset += PAGE_SIZE) {
              await assertLease();
              result.apiRequests += 1;
              const page = await client.listMessages(chat.id, { limit: PAGE_SIZE, offset: messageOffset });
              result.fetched += page.length;
              for (const message of page) considerMessage(message);
              // Messenger returns messages newest first. Read the entire boundary page,
              // including every message with an equal timestamp.
              if (page.length < PAGE_SIZE || page.every((message) => message.createdAtUnix * 1_000 < since)) {
                messagesComplete = true;
                break;
              }
            }
            if (!messagesComplete) throw new Error("AVITO_POLL_MESSAGE_PAGE_LIMIT");
          } catch (error) {
            if (!(error instanceof AvitoApiError) &&
                !(error instanceof Error && error.message === "AVITO_POLL_MESSAGE_PAGE_LIMIT")) throw error;
            result.historyErrors += 1;
            result.failed += 1;
            logger.error("avito.poll.history_unavailable", { source: "AVITO", chatId: chat.id,
              code: error instanceof AvitoApiError ? error.code : "AVITO_POLL_MESSAGE_PAGE_LIMIT",
              httpStatus: error instanceof AvitoApiError ? error.status : null,
              previewAvailable: Boolean(chat.lastMessage),
            });
          }
          const inputs: IncomingPartnerEvent[] = [];
          for (const message of [...messages.values()].sort((a, b) => a.createdAtUnix - b.createdAtUnix)) {
            await assertLease();
            const input = incomingPartnerEventSchema.parse(channel.fromVerifiedMessage(chat.id, message));
            const accepted = await accept(input);
            logger.info(accepted.created ? "avito.poll.new_message" : "avito.poll.duplicate", {
              source: "AVITO", chatId: chat.id, externalEventId: input.externalEventId,
              eventId: accepted.event.id,
            });
            if (accepted.created) {
              result.accepted += 1;
              if (!messagesComplete && message.id === chat.lastMessage?.id) result.previewAccepted += 1;
            }
            if (accepted.event.status === "PROCESSED") { result.duplicates += 1; continue; }
            inputs.push(input);
          }
          // Persist the fetched batch before any LLM call or outbound operation.
          for (const input of inputs) await processOne(input);
        }
        if (chats.length < PAGE_SIZE) { chatsComplete = true; break; }
      }
      if (!chatsComplete) throw new Error("AVITO_POLL_CHAT_PAGE_LIMIT");
      if (result.failed === 0) {
        await assertLease();
        if (!await stateRepository.complete(key, owner, clock(),
          new Date(Math.max(now.getTime(), state.lastCompletedAt?.getTime() ?? 0)))) {
          throw new Error("AVITO_POLL_LEASE_LOST");
        }
      }
    } catch (error) {
      result.failed += 1;
      logger.error("avito.poll.failed", {
        source: "AVITO",
        code: error instanceof AvitoApiError ? error.code :
          error instanceof Error && error.message.startsWith("AVITO_POLL_") ? error.message : "POLLING_ERROR",
        retryable: error instanceof AvitoApiError ? error.retryable : true,
      });
    } finally {
      if (acquired && key) await stateRepository.release(key, owner);
      if (result.failed > 0) result.status = "FAIL";
      result.durationMs = Math.round(performance.now() - started);
      logger.info("avito.poll.completed", { ...result, source: "AVITO" });
    }
    return result;
  };
}
