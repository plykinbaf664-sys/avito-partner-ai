import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Anthropic from "@anthropic-ai/sdk";
import { AnthropicLLMProvider } from "@/integrations/anthropic/anthropic-llm-provider";
import { createMessageExtractor } from "../extraction/extract-message";

import type { ExtractMessageResult } from "../extraction/extract-message";
import { RetryableInfrastructureError } from "../errors/infrastructure-error";
import { SqlitePersistence } from "@/infrastructure/database/sqlite-persistence";
import { AvitoApiError, type AvitoApiClient, type AvitoChat, type AvitoMessage } from "@/integrations/avito/avito-api-client";
import { AvitoOutboundMessageProvider } from "@/integrations/avito/avito-outbound-message-provider";
import { createIncomingEventProcessor } from "./process-incoming-event";
import { createIncomingEventAcceptor } from "./accept-incoming-event";
import { createAvitoMessagePoller } from "./poll-avito-messages";

const extraction: ExtractMessageResult = {
  extraction: {
    intent: "GENERAL_INTEREST",
    facts: {
      phoneNumber: null, phoneConfirmed: false, city: null, budget: null,
      budgetConfirmed: null, availableCapital: null, availableCapitalConfirmed: false,
      entryBudget: null, additionalLaunchCapital: null, capitalScope: "UNKNOWN",
      additionalExpensesReadiness: "UNKNOWN", businessModelReadiness: "UNKNOWN",
      calculationUnits: null, startingUnits: null, scalingPotentialUnits: null,
      hasFreeTime: null, availableTimeDetails: null, businessExperience: null,
      shortTermRentalExperience: null, ownsProperty: null, desiredIncome: null,
      primaryGoal: null, launchTiming: null, managementReadiness: null,
      requiresGuaranteedIncome: null, rejectsBusinessModel: null,
    },
    signals: { questions: [], objections: [], possiblePrimaryFear: null,
      possibleSecondaryFear: null, wantsHuman: false },
    confidence: 0.9, uncertainty: [],
  },
  llm: { model: "test", inputTokens: 1, outputTokens: 1 },
};
const start = new Date("2026-09-13T10:00:00Z");
const key = "avito-messages:owner";
const message = (id = "m1", overrides: Partial<AvitoMessage> = {}): AvitoMessage => ({
  id, authorId: "customer", createdAtUnix: start.getTime() / 1_000 + 1,
  direction: "in", type: "text", text: "Здравствуйте, хочу узнать о партнёрстве", ...overrides,
});

describe("Avito polling through SQLite, Conversation Engine and Avito outbound", () => {
  let persistence: SqlitePersistence;
  let current: Date;
  beforeEach(async () => {
    persistence = await SqlitePersistence.createMigrated("file::memory:");
    current = new Date(start.getTime() + 10_000);
    await persistence.pollingStates.initialize(key, start);
  });
  afterEach(() => persistence.close());

  function harness(database = persistence, chatId?: string) {
    const client = {
      getAuthenticatedAccount: vi.fn().mockResolvedValue({ id: "owner" }),
      listChats: vi.fn().mockResolvedValue([{ id: "chat", updatedAtUnix: null }]),
      listMessages: vi.fn().mockResolvedValue([message()]),
      sendTextMessage: vi.fn().mockResolvedValue("out-1"),
    };
    const extractMessage = vi.fn().mockResolvedValue(extraction);
    const logger = { info: vi.fn(), error: vi.fn() };
    const processIncomingEvent = createIncomingEventProcessor({ persistence: database,
      extractMessage, now: () => current, logger,
      outboundProvider: new AvitoOutboundMessageProvider(client as unknown as AvitoApiClient),
    });
    const poll = createAvitoMessagePoller({ client, persistence: database, chatId,
      stateRepository: database.pollingStates, processIncomingEvent, clock: () => current, logger });
    return { client, extractMessage, processIncomingEvent, poll, logger };
  }

  it("persists a new inbound, processes it, and sends exactly one Avito response", async () => {
    const h = harness();
    expect(await h.poll(current)).toMatchObject({ status: "PASS", accepted: 1, processed: 1 });
    const event = await persistence.incomingEvents.findByIdentity("AVITO", "m1");
    expect(event).toMatchObject({ externalLeadId: "chat", status: "PROCESSED", processingAttempts: 1 });
    const inbound = await persistence.messages.findByIncomingEventId(event!.id);
    const messages = await persistence.messages.listByConversationId(inbound!.conversationId);
    expect(messages.map((m) => m.direction)).toEqual(["INBOUND", "OUTBOUND"]);
    expect(messages[1]).toMatchObject({ deliveryStatus: "SENT", externalMessageId: "out-1" });
    expect(h.client.sendTextMessage).toHaveBeenCalledWith("chat", expect.any(String));
  });

  it("isolates a manual chat, including recovery, without advancing the account cursor", async () => {
    const h = harness(persistence, "chat");
    await persistence.pollingStates.initialize(`${key}:chat:chat`, start);
    await createIncomingEventAcceptor({ persistence })({ source: "AVITO",
      externalEventId: "foreign-pending", externalLeadId: "other-chat",
      messageId: "foreign-pending", text: message().text!, receivedAt: start });
    h.client.listChats.mockResolvedValue([
      { id: "other-chat", updatedAtUnix: null, lastMessage: message("foreign-new") },
      { id: "chat", updatedAtUnix: null, lastMessage: message() },
    ]);
    expect(await h.poll(current)).toMatchObject({ status: "PASS", chats: 2,
      checkedChats: 1, accepted: 1, processed: 1 });
    expect(h.client.listMessages).toHaveBeenCalledExactlyOnceWith("chat", { limit: 100, offset: 0 });
    expect(await persistence.incomingEvents.findByIdentity("AVITO", "foreign-new")).toBeNull();
    expect(await persistence.incomingEvents.findByIdentity("AVITO", "foreign-pending"))
      .toMatchObject({ status: "RECEIVED", processingAttempts: 0 });
    expect((await persistence.pollingStates.initialize(key, current)).lastCompletedAt).toBeNull();
    expect((await persistence.pollingStates.initialize(`${key}:chat:chat`, current)).lastCompletedAt).toEqual(current);
    expect(await h.poll(current)).toMatchObject({ status: "PASS", accepted: 0, processed: 0 });
    expect(h.extractMessage).toHaveBeenCalledTimes(1);
    expect(h.client.sendTextMessage).toHaveBeenCalledExactlyOnceWith("chat", expect.any(String));
  });

  it("ignores old messages and includes every message on the time boundary", async () => {
    const h = harness();
    h.client.listMessages.mockResolvedValue([
      message("old", { createdAtUnix: start.getTime() / 1_000 - 1 }),
      message("boundary", { createdAtUnix: start.getTime() / 1_000 }),
    ]);
    expect(await h.poll(current)).toMatchObject({ status: "PASS", accepted: 1, ignored: 1 });
    expect(await persistence.incomingEvents.findByIdentity("AVITO", "old")).toBeNull();
  });

  it("ignores own outbound, own author even with inbound direction, and system messages", async () => {
    const h = harness();
    h.client.listMessages.mockResolvedValue([
      message("out", { direction: "out" }), message("self", { authorId: "owner" }),
      message("system", { authorId: "0" }), message("image", { type: "image", text: null }),
    ]);
    expect(await h.poll(current)).toMatchObject({ status: "PASS", accepted: 0, ignored: 4 });
    expect(h.extractMessage).not.toHaveBeenCalled();
    expect(h.client.sendTextMessage).not.toHaveBeenCalled();
  });

  it("deduplicates repeated API IDs, repeated polls, and existing webhook events", async () => {
    const h = harness();
    h.client.listMessages.mockResolvedValue([message(), message()]);
    await h.processIncomingEvent({ source: "AVITO", externalEventId: "m1",
      externalLeadId: "chat", messageId: "m1", text: message().text! });
    expect(await h.poll(current)).toMatchObject({ status: "PASS", accepted: 0, duplicates: 2 });
    await h.poll(current);
    expect(h.extractMessage).toHaveBeenCalledTimes(1);
    expect(h.client.sendTextMessage).toHaveBeenCalledTimes(1);
  });

  it("two parallel polls take one lease and process only once", async () => {
    const h = harness();
    let entered!: () => void;
    let resume!: () => void;
    const ready = new Promise<void>((resolve) => { entered = resolve; });
    const gate = new Promise<void>((resolve) => { resume = resolve; });
    h.client.listChats.mockImplementation(async () => {
      entered(); await gate;
      return [{ id: "chat", updatedAtUnix: null }];
    });
    const first = h.poll(current);
    await ready;
    expect(await h.poll(current)).toMatchObject({ status: "BUSY" });
    resume();
    expect(await first).toMatchObject({ status: "PASS", processed: 1 });
    expect(h.extractMessage).toHaveBeenCalledTimes(1);
  });

  it("temporary Avito API failure keeps the cursor and retries successfully", async () => {
    const h = harness();
    h.client.listMessages.mockRejectedValueOnce(new AvitoApiError("AVITO_HTTP_503", 503, true));
    expect(await h.poll(current)).toMatchObject({ status: "FAIL" });
    expect((await persistence.pollingStates.initialize(key, current)).lastCompletedAt).toBeNull();
    current = new Date(current.getTime() + 60_000);
    expect(await h.poll(current)).toMatchObject({ status: "PASS", processed: 1 });
    expect(h.client.sendTextMessage).toHaveBeenCalledTimes(1);
  });

  it("reports returned chats separately from chats skipped by the cursor", async () => {
    const h = harness();
    h.client.listChats.mockResolvedValue([{ id: "old", updatedAtUnix: 1 }]);
    expect(await h.poll(current)).toMatchObject({ status: "PASS", chats: 1,
      checkedChats: 0, skippedOldChats: 1, fetched: 0 });
    expect(h.client.listMessages).not.toHaveBeenCalled();
  });

  it("accepts a verified chat preview when history returns 402, without claiming a complete sweep", async () => {
    const h = harness();
    const chat: AvitoChat = { id: "chat", updatedAtUnix: 1, lastMessage: message() };
    h.client.listChats.mockResolvedValue([chat]);
    h.client.listMessages.mockRejectedValue(new AvitoApiError("AVITO_MESSENGER_ACCESS_PAYMENT_REQUIRED", 402, false));
    expect(await h.poll(current)).toMatchObject({ status: "FAIL", chats: 1, checkedChats: 1,
      accepted: 1, previewAccepted: 1, processed: 1, historyErrors: 1 });
    expect((await persistence.pollingStates.initialize(key, current)).lastCompletedAt).toBeNull();
    expect(await h.poll(current)).toMatchObject({ accepted: 0, processed: 0, duplicates: 1 });
    expect(h.extractMessage).toHaveBeenCalledTimes(1);
    expect(h.client.sendTextMessage).toHaveBeenCalledTimes(1);
  });

  it("continues after a denied chat and deduplicates a preview also returned in history", async () => {
    const h = harness();
    h.client.listChats.mockResolvedValue([
      { id: "denied", updatedAtUnix: null },
      { id: "chat", updatedAtUnix: null, lastMessage: message() },
    ]);
    h.client.listMessages.mockRejectedValueOnce(new AvitoApiError("AVITO_MESSENGER_ACCESS_PAYMENT_REQUIRED", 402, false))
      .mockResolvedValueOnce([message()]);
    expect(await h.poll(current)).toMatchObject({ status: "FAIL", checkedChats: 2,
      accepted: 1, processed: 1, historyErrors: 1 });
    expect(h.client.sendTextMessage).toHaveBeenCalledTimes(1);
  });

  it("does not process an outbound chat preview when history is unavailable", async () => {
    const h = harness();
    h.client.listChats.mockResolvedValue([{ id: "chat", updatedAtUnix: null,
      lastMessage: message("own", { authorId: "owner", direction: "out" }) }]);
    h.client.listMessages.mockRejectedValue(new AvitoApiError("AVITO_MESSENGER_ACCESS_PAYMENT_REQUIRED", 402, false));
    expect(await h.poll(current)).toMatchObject({ accepted: 0, processed: 0 });
    expect(h.extractMessage).not.toHaveBeenCalled();
  });

  it("recovers durably accepted input and an expired processing claim after a crash", async () => {
    const h = harness();
    const accepted = await createIncomingEventAcceptor({ persistence })({ source: "AVITO",
      externalEventId: "crashed", externalLeadId: "chat", messageId: "crashed",
      text: message().text!, receivedAt: start });
    await persistence.incomingEvents.tryClaim(accepted.event.id, start, start, 3);
    await persistence.pollingStates.acquire(key, "dead-process", start, new Date(start.getTime() + 60_000));
    current = new Date(start.getTime() + 11 * 60_000);
    h.client.listMessages.mockResolvedValue([]);
    expect(await h.poll(current)).toMatchObject({ status: "PASS", processed: 1 });
    expect(await persistence.incomingEvents.findByIdentity("AVITO", "crashed"))
      .toMatchObject({ status: "PROCESSED", processingAttempts: 2 });
  });

  it("retries temporary LLM failure from durable input even when the API stops returning it", async () => {
    const h = harness();
    h.extractMessage.mockRejectedValueOnce(new RetryableInfrastructureError("LLM_UNAVAILABLE"));
    expect(await h.poll(current)).toMatchObject({ status: "FAIL", accepted: 1 });
    h.client.listMessages.mockResolvedValue([]);
    current = new Date(current.getTime() + 60_000);
    expect(await h.poll(current)).toMatchObject({ status: "PASS", processed: 1 });
    expect(h.client.sendTextMessage).toHaveBeenCalledTimes(1);
  });

  it("quarantines the production Anthropic 403 failure without blocking other chats or the cursor", async () => {
    const h = harness();
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      error: { type: "forbidden", message: "Request not allowed" },
    }), { status: 403, headers: { "content-type": "application/json" } }));
    const provider = new AnthropicLLMProvider({ apiKey: "test-key", model: "test-model", timeoutMs: 1000 },
      new Anthropic({ apiKey: "test-key", maxRetries: 0, fetch: fetcher }));
    h.extractMessage.mockImplementationOnce(createMessageExtractor({ llmProvider: provider }));
    h.client.listChats.mockResolvedValue([{ id: "chat", updatedAtUnix: null }, { id: "second-item-chat", updatedAtUnix: null }]);
    h.client.listMessages.mockImplementation(async chat => [message(chat === "chat" ? "forbidden" : "healthy")]);
    expect(await h.poll(current)).toMatchObject({ status: "FAIL", accepted: 2, failed: 1, processed: 1 });
    expect(await persistence.incomingEvents.findByIdentity("AVITO", "forbidden")).toMatchObject({
      status: "FAILED", error: "ANTHROPIC_HTTP_403", processingRetryable: false, processingAttempts: 1 });
    expect(h.logger.error).toHaveBeenCalledWith("extraction.failed", expect.objectContaining({
      errorCode: "ANTHROPIC_HTTP_403", retryable: false }));
    expect(h.logger.error).toHaveBeenCalledWith("avito.poll.processing_failed", expect.objectContaining({
      errorCode: "ANTHROPIC_HTTP_403" }));
    current = new Date(current.getTime() + 10_000);
    expect(await h.poll(current)).toMatchObject({ status: "PASS", failed: 0, processed: 0, terminalSkipped: 1 });
    expect((await persistence.pollingStates.initialize(key, current)).lastCompletedAt).toEqual(current);
    expect(h.extractMessage).toHaveBeenCalledTimes(2);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(h.client.sendTextMessage).toHaveBeenCalledExactlyOnceWith("second-item-chat", expect.any(String));
    expect(await persistence.incomingEvents.findByIdentity("AVITO", "forbidden")).toMatchObject({ status: "FAILED", processingAttempts: 1 });
  });

  it("stops exhausted retries even if Avito keeps returning the failed message", async () => {
    const h = harness();
    h.extractMessage.mockRejectedValue(new RetryableInfrastructureError("LLM_UNAVAILABLE"));
    for (let attempt = 1; attempt <= 3; attempt++) {
      expect(await h.poll(current)).toMatchObject({ status: "FAIL", failed: 1 });
      current = new Date(current.getTime() + 10_000);
    }
    expect(await h.poll(current)).toMatchObject({ status: "PASS", failed: 0, terminalSkipped: 1 });
    expect(h.extractMessage).toHaveBeenCalledTimes(3);
    expect(h.client.sendTextMessage).not.toHaveBeenCalled();
    expect((await persistence.pollingStates.initialize(key, current)).lastCompletedAt).toEqual(current);
    expect(await persistence.incomingEvents.findByIdentity("AVITO", "m1")).toMatchObject({ status: "FAILED", processingAttempts: 3 });
  });

  it("skips existing legacy terminal Error records and still answers a fresh message in that chat", async () => {
    const h = harness();
    h.extractMessage.mockRejectedValueOnce(new Error("legacy provider failure"));
    await h.poll(current);
    h.client.listMessages.mockResolvedValue([message(), message("fresh")]);
    expect(await h.poll(current)).toMatchObject({ status: "PASS", processed: 1, failed: 0, terminalSkipped: 1 });
    expect(h.extractMessage).toHaveBeenCalledTimes(2);
    expect(h.client.sendTextMessage).toHaveBeenCalledTimes(1);
    expect(await persistence.incomingEvents.findByIdentity("AVITO", "m1")).toMatchObject({ status: "FAILED", error: "Error", processingAttempts: 1 });
  });

  it("paginates chats and messages, persists and processes messages chronologically", async () => {
    const h = harness();
    h.client.listChats.mockImplementation(async ({ offset }) => offset === 0
      ? Array.from({ length: 100 }, (_, i) => ({ id: `old-${i}`, updatedAtUnix: 1 }))
      : [{ id: "chat", updatedAtUnix: null }]);
    h.client.listMessages.mockImplementation(async (_chat, { offset }) => offset === 0
      ? [message("new", { text: "new", createdAtUnix: start.getTime() / 1_000 + 3 }),
        ...Array.from({ length: 99 }, (_, i) => message(`own-${i}`, { direction: "out" }))]
      : [message("older", { text: "older" })]);
    expect(await h.poll(current)).toMatchObject({ status: "PASS", processed: 2 });
    expect(h.extractMessage.mock.calls.map(([request]) =>
      typeof request === "string" ? request : request.text)).toEqual(["older", "new"]);
    expect(h.client.listChats).toHaveBeenLastCalledWith({ unreadOnly: false, limit: 100, offset: 100 });
  });

  it("does not advance the cursor when API pagination cannot be exhausted", async () => {
    const h = harness();
    h.client.listChats.mockResolvedValue(Array.from({ length: 100 }, (_, i) => ({
      id: `old-${i}`, updatedAtUnix: 1,
    })));
    expect(await h.poll(current)).toMatchObject({ status: "FAIL" });
    expect((await persistence.pollingStates.initialize(key, current)).lastCompletedAt).toBeNull();
  });

  it("re-reads the overlap to discover late messages and deduplicates known old messages", async () => {
    const h = harness();
    await h.poll(current);
    current = new Date(current.getTime() + 60_000);
    h.client.listMessages.mockResolvedValue([message(), message("late")]);
    expect(await h.poll(current)).toMatchObject({ status: "PASS", accepted: 1, duplicates: 1 });
    expect(h.client.sendTextMessage).toHaveBeenCalledTimes(2);
  });

  it("separate SQLite connections share the lease and restart state", async () => {
    const directory = await mkdtemp(join(tmpdir(), "avito-poll-"));
    const url = `file:${join(directory, "test.db").replaceAll("\\", "/")}`;
    const first = await SqlitePersistence.createMigrated(url);
    const second = SqlitePersistence.create(url);
    try {
      await first.pollingStates.initialize(key, start);
      const h1 = harness(first);
      let resume!: () => void;
      let entered!: () => void;
      const ready = new Promise<void>((resolve) => { entered = resolve; });
      const gate = new Promise<void>((resolve) => { resume = resolve; });
      h1.client.listChats.mockImplementation(async () => {
        entered(); await gate; return [{ id: "chat", updatedAtUnix: null }];
      });
      const pending = h1.poll(current);
      await ready;
      const h2 = harness(second);
      expect(await h2.poll(current)).toMatchObject({ status: "BUSY" });
      resume(); await pending;
      expect(await h2.poll(current)).toMatchObject({ status: "PASS", duplicates: 1, processed: 0 });
      expect(h2.client.sendTextMessage).not.toHaveBeenCalled();
    } finally {
      first.close(); second.close();
      await rm(directory, { recursive: true, force: true }).catch((error: NodeJS.ErrnoException) => {
        // libsql's native Windows handles can survive close() until process exit.
        // Leave only the OS temp fixture in that case; never swallow assertion errors.
        if (process.platform !== "win32" || error.code !== "EBUSY") throw error;
      });
    }
  });
});
