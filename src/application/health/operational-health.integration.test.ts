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
    await run(new Date(at.getTime()+60_000));
    expect(sender.sendMessage).toHaveBeenCalledOnce();
    await persistence.operations.observe("AVITO_MESSENGER", "OK", null, new Date(at.getTime()+120_000));
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
});
