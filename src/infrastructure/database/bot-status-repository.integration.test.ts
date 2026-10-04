import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createInitialLead } from "@/application/workflows/process-incoming-event";
import { formatBotStatus, statusPeriods } from "@/application/analytics/bot-status";
import type { Lead } from "@/domain/lead/lead";
import type { ManagerSummary } from "@/domain/handoff/manager-summary";
import type { DeliveryStatus } from "@/domain/delivery/delivery-state";
import { SqlitePersistence } from "./sqlite-persistence";

const now = new Date("2026-10-04T12:00:00Z");
const today = new Date("2026-10-03T21:00:00Z"); // Midnight Moscow.

describe("Telegram bot status aggregates", () => {
  let db: SqlitePersistence;
  beforeEach(async () => { db = await SqlitePersistence.createMigrated("file::memory:"); });
  afterEach(() => db.close());

  async function lead(id: string, first: Date | null, source = "AVITO", patch: Partial<Lead> = {}) {
    const createdAt = first ?? today;
    await db.leads.insert({ ...createInitialLead(id, source, `external-${id}`, createdAt),
      name: "PRIVATE_NAME", phoneNumber: "+79991234567", ...patch });
    await db.conversations.insert({ id: `c-${id}`, leadId: id, state: "QUALIFYING", summary: null,
      pendingInformationNeed: null, lastInboundAt: first, lastOutboundAt: null,
      awaitingUserReply: false, qualificationCompleted: false, followUpEligibleAt: null,
      followUpCount: 0, lastFollowUpAt: null, nextInboundSequence: 0, lastAppliedInboundSequence: 0,
      createdAt, updatedAt: createdAt, closedAt: null });
    if (first) await message(`first-${id}`, id, first);
  }

  async function message(id: string, leadId: string, at: Date, ai = false, status: DeliveryStatus = "SENT") {
    await db.messages.insert({ id, leadId, conversationId: `c-${leadId}`, incomingEventId: null,
      externalMessageId: null, deduplicationKey: null, sequence: null,
      direction: ai ? "OUTBOUND" : "INBOUND", actor: ai ? "AI" : "USER", content: "PRIVATE_MESSAGE",
      deliveryStatus: ai ? status : null, deliveryAttempts: ai ? 1 : 0, deliveryRetryable: null,
      lastDeliveryErrorCode: null, sentAt: ai && status === "SENT" ? at : null, createdAt: at });
  }

  async function notification(id: string, leadId: string, status: DeliveryStatus, at = today) {
    await db.managerNotifications.insertIfAbsent({ id, leadId, conversationId: `c-${leadId}`,
      qualificationStatus: "HOT", summary: {} as ManagerSummary, idempotencyKey: id,
      deliveryStatus: status, deliveryAttempts: 1, deliveryRetryable: true,
      lastDeliveryErrorCode: null, externalNotificationId: null, createdAt: at, updatedAt: at,
      sentAt: status === "SENT" ? at : null });
  }

  async function delivery(id: string, notificationId: string, recipientId: string, status: DeliveryStatus, at = today) {
    await db.telegramManagerDeliveries.insertIfAbsent({ id, managerNotificationId: notificationId,
      recipientId, idempotencyKey: id, deliveryStatus: status, deliveryAttempts: 1,
      deliveryRetryable: status === "FAILED", lastDeliveryErrorCode: null, externalMessageId: null,
      createdAt: at, updatedAt: at, sentAt: status === "SENT" ? at : null });
  }

  it("returns zero counts and undefined conversion without PII on an empty database", async () => {
    const snapshot = await db.botStatus.snapshot(now);
    expect(snapshot.periods).toHaveLength(3);
    for (const period of snapshot.periods) expect(period).toMatchObject({
      startedDialogs: 0, activeDialogs: 0, aiAnsweredDialogs: 0,
      transferredLeads: 0, transferredNewDialogs: 0,
    });
    expect(formatBotStatus(snapshot)).toContain("Конверсия новых диалогов: — (0/0)");
    expect(formatBotStatus(snapshot).length).toBeLessThan(4096);
  });

  it("uses Moscow calendar boundaries including the last seven calendar days", () => {
    expect(statusPeriods(now).map(({ since }) => since.toISOString())).toEqual([
      "2026-10-03T21:00:00.000Z", "2026-09-27T21:00:00.000Z", "1970-01-01T00:00:00.000Z",
    ]);
    expect(statusPeriods(new Date("2026-10-03T20:59:59.999Z"))[0].since.toISOString())
      .toBe("2026-10-02T21:00:00.000Z");
    expect(() => statusPeriods(new Date("invalid"))).toThrow("Invalid status date");
  });

  it("deduplicates clients, recipient fanout and retries; separates period volume from cohort conversion", async () => {
    for (const id of ["a", "b"]) await db.telegramManagerRecipients.upsertAuthorized({
      id, telegramChatId: id, telegramUserId: id, username: null, firstName: null,
      isActive: true, authorizedAt: today, createdAt: today, updatedAt: today,
    });
    await lead("old", new Date("2026-09-27T20:59:59Z"));
    await lead("fresh", today);
    await lead("yesterday", new Date("2026-10-03T20:59:59Z"), "AVITO", {
      phoneNumber: null, phoneConfirmed: false, qualificationStatus: "HOT", qualificationReason: "PHONE_UNKNOWN",
    });
    await lead("legacy", new Date("2026-09-01T00:00:00Z"), "avito", { handoffAt: today });
    await lead("lab", today, "TEST_CHAT_LAB");
    await lead("demo", today, "LOCAL");
    await lead("future", new Date("2026-10-05T00:00:00Z"));
    await lead("no-inbound", null);
    for (const id of ["old", "fresh", "yesterday"]) await message(`active-${id}`, id, now);
    await message("repeat-fresh", "fresh", now);
    await message("old-ai", "old", now, true);
    await message("pending-ai", "fresh", now, true, "PENDING");
    await message("future-ai", "fresh", new Date("2026-10-05T00:00:00Z"), true);
    await notification("old-card", "old", "FAILED"); // Partial fanout success counts as handed off.
    await delivery("old-a", "old-card", "a", "SENT");
    await delivery("old-b", "old-card", "b", "FAILED");
    await notification("fresh-card", "fresh", "SENT");
    await delivery("fresh-a", "fresh-card", "a", "SENT");
    await delivery("fresh-b", "fresh-card", "b", "SENT");
    await notification("fresh-retry", "fresh", "SENT");
    await delivery("fresh-retry-a", "fresh-retry", "a", "SENT");
    await notification("legacy-pending", "legacy", "PENDING");
    await notification("lab-card", "lab", "SENT");
    await delivery("lab-a", "lab-card", "a", "SENT");
    const snapshot = await db.botStatus.snapshot(now);
    expect(snapshot.periods[0]).toMatchObject({ startedDialogs: 1, activeDialogs: 3,
      aiAnsweredDialogs: 1, transferredLeads: 2, transferredNewDialogs: 1 });
    expect(snapshot.periods[1]).toMatchObject({ startedDialogs: 2, activeDialogs: 3,
      transferredLeads: 2, transferredNewDialogs: 1 });
    expect(snapshot.periods[2]).toMatchObject({ startedDialogs: 4, activeDialogs: 4,
      transferredLeads: 2, transferredNewDialogs: 2 });
    expect(snapshot).toMatchObject({ awaitingPhone: 1, pendingHandoffs: 1, failedHandoffs: 1 });
    const text = formatBotStatus(snapshot);
    expect(text).toContain("Конверсия новых диалогов: 100% (1/1)");
    expect(text).not.toMatch(/PRIVATE_NAME|PRIVATE_MESSAGE|79991234567|NaN|Infinity/);
  });

  it("counts failed and pending ingestion independently of handoff and excludes test/future events", async () => {
    for (const [id, status, source, receivedAt] of [
      ["received", "RECEIVED", "AVITO", now], ["processing", "PROCESSING", "AVITO", now],
      ["failed", "FAILED", "AVITO", now], ["done", "PROCESSED", "AVITO", now],
      ["lab", "FAILED", "TEST_CHAT_LAB", now], ["future", "RECEIVED", "AVITO", new Date("2026-10-05T00:00:00Z")],
    ] as const) await db.incomingEvents.register({ id, source, externalEventId: id, externalLeadId: id,
      status, receivedAt, payload: {}, error: null, processingAttempts: 1, processingRetryable: true,
      extraction: null, llmModel: null, llmInputTokens: null, llmOutputTokens: null, llmLatencyMs: null,
      totalProcessingLatencyMs: null, processingStartedAt: null, processedAt: null });
    const snapshot = await db.botStatus.snapshot(now);
    expect(snapshot).toMatchObject({ pendingInboundEvents: 2, failedInboundEvents: 1 });
  });
});
