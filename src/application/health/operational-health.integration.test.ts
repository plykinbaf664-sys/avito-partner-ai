import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SqlitePersistence } from "@/infrastructure/database/sqlite-persistence";
import { readOperationalStatus } from "./operational-health";
import { runProductionWatchdog } from "./production-watchdog";
import { createAvitoRuntimeSafety } from "./avito-runtime-safety";
import { createIncomingEventAcceptor } from "../workflows/accept-incoming-event";
import { createExternalConversationMessageRecorder } from "../workflows/record-external-message";
import type { ProcessIncomingEventResult } from "../workflows/process-incoming-event";

describe("operational safety with real SQLite", () => {
  let persistence: SqlitePersistence;
  const at = new Date("2026-10-09T15:00:00Z");
  beforeEach(async () => { persistence = await SqlitePersistence.createMigrated("file::memory:"); });
  afterEach(() => persistence.close());
  const input = { source: "AVITO", externalEventId: "new-inbound", externalLeadId: "synthetic-chat",
    messageId: "new-inbound", text: "Здравствуйте, интересует сотрудничество", receivedAt: at };

  async function authorizeTwoManagers() {
    for (const id of ["available", "unavailable"]) await persistence.telegramManagerRecipients.upsertAuthorized({
      id, telegramChatId: id, telegramUserId: id, username: null, firstName: null, isActive: true,
      authorizedAt: at, createdAt: at, updatedAt: at });
    await persistence.operations.observe("AVITO_POLLING", "OK", null, at);
    await persistence.operations.observe("AVITO_MESSENGER", "BLOCKED", "AVITO_UNAUTHORIZED", at);
  }

  it("keeps brief network failures and their recovery silent but reports a sustained outage", async () => {
    await authorizeTwoManagers();
    await persistence.operations.observe("AVITO_MESSENGER", "OK", null, at);
    const sender = { sendMessage: vi.fn().mockResolvedValue({ status: "SENT", externalId: "alert" }) };
    const run = (now: Date) => runProductionWatchdog({ persistence, sender, now, probeHttp: async () => true });
    for (let minute = 1; minute <= 3; minute++) {
      const now = new Date(at.getTime() + minute * 60_000);
      await persistence.operations.observe("AVITO_MESSENGER", "DEGRADED", "AVITO_NETWORK_ERROR", now);
      await persistence.operations.observe("AVITO_POLLING", "DEGRADED", "AVITO_POLL_FAILED", now);
      await run(now);
    }
    expect(sender.sendMessage).not.toHaveBeenCalled();
    const recovered = new Date(at.getTime() + 4 * 60_000);
    await persistence.operations.observe("AVITO_MESSENGER", "OK", null, recovered);
    await persistence.operations.observe("AVITO_POLLING", "OK", null, recovered);
    await run(recovered);
    expect(sender.sendMessage).not.toHaveBeenCalled();
    for (let minute = 5; minute <= 10; minute++) {
      const now = new Date(at.getTime() + minute * 60_000);
      await persistence.operations.observe("AVITO_MESSENGER", "DEGRADED", "AVITO_NETWORK_ERROR", now);
      await persistence.operations.observe("AVITO_POLLING", "DEGRADED", "AVITO_POLL_FAILED", now);
      await run(now);
    }
    expect(sender.sendMessage).toHaveBeenCalledTimes(2); // once per recipient
  });

  it("retries only failed recipients and sends recovery only to recipients who saw the outage", async () => {
    await authorizeTwoManagers();
    const sender = { sendMessage: vi.fn().mockImplementation(async (chat: string) => chat === "available"
      ? { status: "SENT", externalId: "alert" } : { status: "FAILED", retryable: true, errorCode: "TELEGRAM_NETWORK_ERROR" }) };
    const run = (now: Date) => runProductionWatchdog({ persistence, sender, now, probeHttp: async () => true });
    await run(at);
    await run(new Date(at.getTime() + 60_000));
    expect(sender.sendMessage.mock.calls.filter(([chat]) => chat === "available")).toHaveLength(1);
    const healthy = new Date(at.getTime() + 120_000);
    await persistence.operations.observe("AVITO_MESSENGER", "OK", null, healthy);
    await persistence.operations.observe("AVITO_POLLING", "OK", null, healthy);
    await run(healthy);
    expect(sender.sendMessage.mock.calls.filter(([chat]) => chat === "available")).toHaveLength(2);
    expect(sender.sendMessage.mock.calls.filter(([chat, text]) => chat === "unavailable" && text.includes("восстановлена"))).toHaveLength(0);
    expect(sender.sendMessage.mock.calls.filter(([chat]) => chat === "available")[1][1]).toContain("восстановлена");
  });

  it("continues delivering to other recipients after a thrown send and deduplicates across independent watchdogs", async () => {
    await authorizeTwoManagers();
    const sender = { sendMessage: vi.fn().mockImplementation(async (chat: string) => {
      if (chat === "available") throw new Error("private transport details");
      return { status: "SENT", externalId: "alert" };
    }) };
    await Promise.all([1, 2].map(() => runProductionWatchdog({ persistence, sender, now: at, probeHttp: async () => true })));
    expect(sender.sendMessage.mock.calls.filter(([chat]) => chat === "unavailable")).toHaveLength(1);
    await runProductionWatchdog({ persistence, sender, now: new Date(at.getTime()+60_000), probeHttp: async () => true });
    expect(sender.sendMessage.mock.calls.filter(([chat]) => chat === "unavailable")).toHaveLength(1);
  });

  it("backs off a permanently inaccessible recipient without repeating a delivered alert", async () => {
    await authorizeTwoManagers();
    const sender = { sendMessage: vi.fn().mockImplementation(async (chat: string) => chat === "available"
      ? { status: "SENT", externalId: "alert" } : { status: "FAILED", retryable: false, errorCode: "TELEGRAM_HTTP_403" }) };
    for (let minute=0; minute<5; minute++) await runProductionWatchdog({ persistence, sender,
      now: new Date(at.getTime()+minute*60_000), probeHttp: async () => true });
    expect(sender.sendMessage.mock.calls.filter(([chat]) => chat === "available")).toHaveLength(1);
    expect(sender.sendMessage.mock.calls.filter(([chat]) => chat === "unavailable")).toHaveLength(1);
  });

  it("keeps blocked inbound visible in CRM without spending processing attempts, and resumes after recovery", async () => {
    const process = vi.fn().mockResolvedValue({} as ProcessIncomingEventResult);
    const safety = createAvitoRuntimeSafety(persistence, process, () => at);
    const accepted = await createIncomingEventAcceptor({ persistence, now: () => at })(input);
    await safety.observeHistoryResult("AVITO_MESSENGER_ACCESS_PAYMENT_REQUIRED");
    await expect(safety.processIncomingEvent(input)).rejects.toThrow("AVITO_CHANNEL_ACCESS_BLOCKED");
    await expect(safety.processIncomingEvent(input)).rejects.toThrow("AVITO_CHANNEL_ACCESS_BLOCKED");
    expect(process).not.toHaveBeenCalled();
    expect(await persistence.incomingEvents.findByIdentity("AVITO", input.externalEventId)).toMatchObject({
      status: "RECEIVED", processingAttempts: 0 });
    const lead = await persistence.leads.findByExternalIdentity("AVITO", input.externalLeadId);
    expect(await persistence.crm.findLeadSnapshot(lead!.id)).not.toBeNull();
    expect((await persistence.messages.listByLeadId(lead!.id)).filter(row => row.direction === "INBOUND")).toHaveLength(1);
    expect((await persistence.messages.findByIncomingEventId(accepted.event.id))!.content).toBe(input.text);
    await safety.observeHistoryResult(null);
    await safety.processIncomingEvent(input);
    expect(process).toHaveBeenCalledOnce();
  });

  it("suppresses an old queued answer already handled by a human without suppressing a newer client turn", async () => {
    const process = vi.fn().mockResolvedValue({} as ProcessIncomingEventResult);
    const safety = createAvitoRuntimeSafety(persistence, process, () => at);
    await createExternalConversationMessageRecorder({ persistence })({ source: "AVITO", externalLeadId: input.externalLeadId,
      externalMessageId: "human", text: "Я отвечу на Ваш вопрос.", createdAt: new Date(at.getTime()+1_000) });
    await safety.processIncomingEvent(input);
    expect(process).toHaveBeenLastCalledWith(input, { suppressOutbound: true });
    const newer = { ...input, externalEventId: "newer", receivedAt: new Date(at.getTime()+2_000) };
    await safety.processIncomingEvent(newer);
    expect(process).toHaveBeenLastCalledWith(newer, undefined);
  });

  it("keeps conversation clocks monotonic while old blocked inbound is retried after a newer human and client turn", async () => {
    const safety = createAvitoRuntimeSafety(persistence, vi.fn(), () => at);
    const accept = createIncomingEventAcceptor({ persistence, now: () => at });
    await accept(input);
    await safety.observeHistoryResult("AVITO_MESSENGER_ACCESS_PAYMENT_REQUIRED");
    await expect(safety.processIncomingEvent(input)).rejects.toThrow("AVITO_CHANNEL_ACCESS_BLOCKED");
    const humanAt = new Date(at.getTime()+60_000);
    await createExternalConversationMessageRecorder({ persistence })({ source: "AVITO", externalLeadId: input.externalLeadId,
      externalMessageId: "later-human", text: "Я отвечу на Ваш вопрос.", createdAt: humanAt });
    const later = { ...input, externalEventId: "later-client", messageId: "later-client", receivedAt: new Date(at.getTime()+120_000) };
    await accept(later);
    await expect(safety.processIncomingEvent(later)).rejects.toThrow("AVITO_CHANNEL_ACCESS_BLOCKED");
    await expect(safety.processIncomingEvent(input)).rejects.toThrow("AVITO_CHANNEL_ACCESS_BLOCKED");
    const lead = await persistence.leads.findByExternalIdentity("AVITO", input.externalLeadId);
    const conversation = await persistence.conversations.findOpenByLeadId(lead!.id);
    expect(conversation!.updatedAt.getTime()).toBeGreaterThanOrEqual(later.receivedAt.getTime());
    expect(conversation!.lastInboundAt).toEqual(later.receivedAt);
    expect(conversation!.lastOutboundAt).toEqual(humanAt);
  });

  it("reports a live process with a blocked Messenger as not ready and catches stale polling independently", async () => {
    await persistence.operations.observe("AVITO_POLLING", "OK", null, at);
    await persistence.operations.observe("AVITO_MESSENGER", "OK", null, at);
    expect((await readOperationalStatus(persistence, at)).ready).toBe(true);
    await persistence.operations.observe("AVITO_MESSENGER", "BLOCKED", "AVITO_MESSENGER_ACCESS_PAYMENT_REQUIRED", at);
    expect((await readOperationalStatus(persistence, at)).issues).toContain("AVITO_MESSENGER:AVITO_MESSENGER_ACCESS_PAYMENT_REQUIRED");
    expect((await readOperationalStatus(persistence, new Date(at.getTime()+6*60_000))).issues).toContain("AVITO_POLLING_STALE");
    await persistence.operations.observe("AVITO_MESSENGER", "OK", null, new Date(at.getTime()+1_000));
    await persistence.operations.observe("AVITO_MESSENGER", "BLOCKED", "AVITO_FORBIDDEN", at);
    expect((await persistence.operations.list()).find(row => row.component === "AVITO_MESSENGER")!.state).toBe("OK");
  });

  it("requires recent Messenger evidence instead of treating a live empty sweep as proof of access", async () => {
    await persistence.operations.observe("AVITO_POLLING", "OK", null, at);
    expect((await readOperationalStatus(persistence, at)).issues).toContain("AVITO_MESSENGER_UNVERIFIED");
    await persistence.operations.observe("AVITO_MESSENGER", "OK", null, at);
    await persistence.operations.observe("AVITO_POLLING", "OK", null, new Date(at.getTime()+6*60_000));
    expect((await readOperationalStatus(persistence, new Date(at.getTime()+6*60_000))).issues).toContain("AVITO_MESSENGER_STALE");
  });

  it("does not suspend every conversation because one chat returns forbidden", async () => {
    const process = vi.fn().mockResolvedValue({} as ProcessIncomingEventResult);
    const safety = createAvitoRuntimeSafety(persistence, process, () => at);
    await safety.observeHistoryResult("AVITO_FORBIDDEN");
    await safety.processIncomingEvent(input);
    expect(process).toHaveBeenCalledOnce();
    expect((await persistence.operations.list())[0]).toMatchObject({ state: "DEGRADED", errorCode: "AVITO_FORBIDDEN" });
  });

  it("does not treat an intentionally cancelled follow-up as an unresolved delivery failure", async () => {
    const safety = createAvitoRuntimeSafety(persistence, vi.fn(), () => at);
    await createIncomingEventAcceptor({ persistence, now: () => at })(input);
    await safety.observeHistoryResult("AVITO_MESSENGER_ACCESS_PAYMENT_REQUIRED");
    await expect(safety.processIncomingEvent(input)).rejects.toThrow("AVITO_CHANNEL_ACCESS_BLOCKED");
    const event = await persistence.incomingEvents.findByIdentity("AVITO", input.externalEventId);
    const message = await persistence.messages.findByIncomingEventId(event!.id);
    await persistence.messages.insert({ ...message!, id: "cancelled-follow-up", incomingEventId: null,
      externalMessageId: null, direction: "OUTBOUND", actor: "AI", sequence: null,
      deliveryStatus: "FAILED", deliveryRetryable: false, lastDeliveryErrorCode: "CANCELLED_BY_INBOUND" });
    expect((await persistence.operations.backlog(new Date(at.getTime()+120_000))).unresolvedOutbound).toBe(0);
  });

  it("deduplicates independent watchdog alerts, reports recovery once and keeps customer content out", async () => {
    await persistence.operations.observe("AVITO_POLLING", "OK", null, at);
    await persistence.operations.observe("AVITO_MESSENGER", "BLOCKED", "AVITO_MESSENGER_ACCESS_PAYMENT_REQUIRED", at);
    await persistence.telegramManagerRecipients.upsertAuthorized({ id: "manager", telegramChatId: "synthetic-chat",
      telegramUserId: "synthetic-manager", username: null, firstName: null, isActive: true, authorizedAt: at, createdAt: at, updatedAt: at });
    const sender = { sendMessage: vi.fn().mockResolvedValue({ status: "SENT", externalId: "alert" }) };
    const run = (now: Date) => runProductionWatchdog({ persistence, sender, now, probeHttp: async () => true });
    const results = await Promise.all([run(at), run(at)]);
    expect(results.filter(row => row.alerted)).toHaveLength(1);
    expect(sender.sendMessage).toHaveBeenCalledOnce();
    expect(sender.sendMessage.mock.calls[0][1]).toContain("HTTP 402");
    expect(sender.sendMessage.mock.calls[0][1]).not.toContain(input.text);
    for (let count=0;count<3;count++) await persistence.operations.observe("AVITO_POLLING", "DEGRADED", "AVITO_POLL_FAILED", new Date(at.getTime()+1_000));
    await run(new Date(at.getTime()+60_000));
    expect(sender.sendMessage).toHaveBeenCalledOnce();
    await persistence.operations.observe("AVITO_MESSENGER", "OK", null, new Date(at.getTime()+120_000));
    await persistence.operations.observe("AVITO_POLLING", "OK", null, new Date(at.getTime()+120_000));
    expect((await run(new Date(at.getTime()+120_000))).alerted).toBe(true);
    expect(sender.sendMessage.mock.calls[1][1]).toContain("восстановлена");
    await run(new Date(at.getTime()+180_000));
    expect(sender.sendMessage).toHaveBeenCalledTimes(2);
  });

  it("does not announce recovery before any incident and retries failed alert delivery", async () => {
    await persistence.operations.observe("AVITO_POLLING", "OK", null, at);
    await persistence.operations.observe("AVITO_MESSENGER", "OK", null, at);
    await persistence.telegramManagerRecipients.upsertAuthorized({ id: "manager", telegramChatId: "synthetic-chat",
      telegramUserId: "synthetic-manager", username: null, firstName: null, isActive: true, authorizedAt: at, createdAt: at, updatedAt: at });
    const sender = { sendMessage: vi.fn().mockResolvedValueOnce({ status: "FAILED", retryable: true, errorCode: "NETWORK_ERROR" })
      .mockResolvedValue({ status: "SENT", externalId: "alert" }) };
    const run = (now: Date) => runProductionWatchdog({ persistence, sender, now, probeHttp: async () => true });
    expect((await run(at)).alerted).toBe(false);
    expect(sender.sendMessage).not.toHaveBeenCalled();
    await persistence.operations.observe("AVITO_MESSENGER", "BLOCKED", "AVITO_UNAUTHORIZED", at);
    expect((await run(at)).alertDelivery).toBe("FAILED");
    expect((await run(new Date(at.getTime()+60_000))).alerted).toBe(true);
  });

  it("keeps one outage open across changing symptoms and hours without reminder spam", async () => {
    await persistence.telegramManagerRecipients.upsertAuthorized({ id: "manager", telegramChatId: "synthetic-chat",
      telegramUserId: "synthetic-manager", username: null, firstName: null, isActive: true, authorizedAt: at, createdAt: at, updatedAt: at });
    const sender = { sendMessage: vi.fn().mockResolvedValue({ status: "SENT", externalId: "alert" }) };
    const run = (now: Date) => runProductionWatchdog({ persistence, sender, now, probeHttp: async () => true });
    await persistence.operations.observe("AVITO_POLLING", "OK", null, at);
    await persistence.operations.observe("AVITO_MESSENGER", "DEGRADED", "AVITO_NETWORK_ERROR", at);
    // First stale evidence is the same outage as the later stale polling evidence.
    await run(new Date(at.getTime()+6*60_000));
    expect(sender.sendMessage).toHaveBeenCalledOnce();
    await persistence.operations.observe("AVITO_MESSENGER", "BLOCKED", "AVITO_UNAUTHORIZED", new Date(at.getTime()+7*60_000));
    await run(new Date(at.getTime()+7*60_000));
    await run(new Date(at.getTime()+40*60_000));
    await run(new Date(at.getTime()+3*60*60_000));
    expect(sender.sendMessage).toHaveBeenCalledOnce();
    const recovered = new Date(at.getTime()+3*60*60_000+60_000);
    await persistence.operations.observe("AVITO_POLLING", "OK", null, recovered);
    await persistence.operations.observe("AVITO_MESSENGER", "OK", null, recovered);
    await run(recovered);
    await run(new Date(recovered.getTime()+60_000));
    expect(sender.sendMessage).toHaveBeenCalledTimes(2);
    expect(sender.sendMessage.mock.calls[1][1]).toContain("восстановлена");
    await persistence.operations.observe("AVITO_MESSENGER", "BLOCKED", "AVITO_UNAUTHORIZED", new Date(recovered.getTime()+120_000));
    await run(new Date(recovered.getTime()+120_000));
    expect(sender.sendMessage).toHaveBeenCalledTimes(3);
  });

  it("does not announce recovery on a merely tolerated degraded polling observation", async () => {
    await persistence.telegramManagerRecipients.upsertAuthorized({ id: "manager", telegramChatId: "synthetic-chat",
      telegramUserId: "synthetic-manager", username: null, firstName: null, isActive: true, authorizedAt: at, createdAt: at, updatedAt: at });
    const sender = { sendMessage: vi.fn().mockResolvedValue({ status: "SENT", externalId: "alert" }) };
    const run = (now: Date) => runProductionWatchdog({ persistence, sender, now, probeHttp: async () => true });
    await persistence.operations.observe("AVITO_POLLING", "OK", null, at);
    await persistence.operations.observe("AVITO_MESSENGER", "BLOCKED", "AVITO_UNAUTHORIZED", at);
    await run(at);
    const next = new Date(at.getTime()+60_000);
    await persistence.operations.observe("AVITO_MESSENGER", "OK", null, next);
    await persistence.operations.observe("AVITO_POLLING", "DEGRADED", "AVITO_POLL_FAILED", next);
    expect((await run(next)).status.ready).toBe(true);
    expect(sender.sendMessage).toHaveBeenCalledOnce();
    const healthy = new Date(next.getTime()+60_000);
    await persistence.operations.observe("AVITO_POLLING", "OK", null, healthy);
    await run(healthy);
    expect(sender.sendMessage).toHaveBeenCalledTimes(2);
  });

  it("preserves an already notified legacy incident across deployment without another outage alert", async () => {
    await persistence.operations.observe("APPLICATION_HTTP", "OK", null, at);
    const owner = await persistence.operations.claimAlert("APPLICATION_HTTP", "legacy-issue-specific-fingerprint", at);
    expect(owner).not.toBeNull();
    await persistence.operations.finishAlert("APPLICATION_HTTP", owner!, "legacy-issue-specific-fingerprint", true, at);
    await persistence.telegramManagerRecipients.upsertAuthorized({ id: "manager", telegramChatId: "synthetic-chat",
      telegramUserId: "synthetic-manager", username: null, firstName: null, isActive: true, authorizedAt: at, createdAt: at, updatedAt: at });
    const sender = { sendMessage: vi.fn().mockResolvedValue({ status: "SENT", externalId: "alert" }) };
    const next = new Date(at.getTime()+60_000);
    await persistence.operations.observe("AVITO_POLLING", "OK", null, next);
    await persistence.operations.observe("AVITO_MESSENGER", "BLOCKED", "AVITO_UNAUTHORIZED", next);
    await runProductionWatchdog({ persistence, sender, now: next, probeHttp: async () => true });
    expect(sender.sendMessage).not.toHaveBeenCalled();
    const healthy = new Date(next.getTime()+60_000);
    await persistence.operations.observe("AVITO_MESSENGER", "OK", null, healthy);
    await runProductionWatchdog({ persistence, sender, now: healthy, probeHttp: async () => true });
    expect(sender.sendMessage).toHaveBeenCalledOnce();
    expect(sender.sendMessage.mock.calls[0][1]).toContain("восстановлена");
  });
});
