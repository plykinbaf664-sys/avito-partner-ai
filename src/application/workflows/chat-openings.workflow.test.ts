import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SqlitePersistence } from "@/infrastructure/database/sqlite-persistence";
import { createChatOpeningWorkflow } from "./process-chat-openings";
import type { AvitoChat, AvitoMessage } from "@/integrations/avito/avito-api-client";
import type { NaturalResponseGenerator } from "../conversation/generate-natural-response";
import { createExternalConversationMessageRecorder } from "./record-external-message";

describe("service-only Avito chat opening", () => {
  let db: SqlitePersistence;
  const start = new Date("2026-10-11T12:00:00Z");
  let now: Date;
  let history: AvitoMessage[];
  const chat = (): AvitoChat => ({ id: "new-chat", updatedAtUnix: null,
    createdAtUnix: start.getTime() / 1000 + 1,
    listingOwnerId: "owner", contextType: "item", participantIds: ["owner", "customer"] });
  beforeEach(async () => {
    db = await SqlitePersistence.createMigrated("file::memory:"); now = new Date(start.getTime() + 10_000);
    history = [{ id: "notice", authorId: "0", type: "system", direction: "in",
      text: "A buyer has opened a conversation about the listing.", createdAtUnix: start.getTime() / 1000 + 2,
      origin: "MESSAGE_HISTORY" }];
  });
  afterEach(() => db.close());
  function setup() {
    const telemetry = { model: "fake", inputTokens: 0, outputTokens: 0 };
    const generate = vi.fn<NaturalResponseGenerator>().mockResolvedValue({ replyAction: "SEND_REPLY",
      text: "Здравствуйте! Поможем разобраться в запуске бизнеса на посуточной аренде. Что хотели бы узнать?",
      nextInformationNeed: null, awaitingUserReply: true, ...telemetry });
    const deliver = vi.fn().mockResolvedValue({ status: "SENT", externalId: "opening-id" });
    const readHistory = vi.fn(async () => history);
    const workflow = createChatOpeningWorkflow({ persistence: db, stateRepository: db.pollingStates,
      generateNaturalResponse: generate, outboundProvider: { deliver }, readHistory, clock: () => now });
    return { workflow, generate, deliver, readHistory };
  }
  async function discover(h: ReturnType<typeof setup>) {
    await h.workflow.start("owner", start);
    await h.workflow.observe(chat(), "owner", now);
  }
  it("discovers without inventing inbound speech, waits, sends once and schedules the existing silence workflow", async () => {
    const h = setup(); await discover(h);
    const lead = (await db.leads.findByExternalIdentity("AVITO", "new-chat"))!;
    const conversation = (await db.conversations.findOpenByLeadId(lead.id))!;
    expect(conversation.lastInboundAt).toBeNull();
    expect(await db.messages.listByLeadId(lead.id)).toEqual([]);
    await h.workflow.processDue(now); expect(h.generate).not.toHaveBeenCalled();
    now = new Date(now.getTime() + 120_000); await h.workflow.processDue(now);
    expect(h.generate).toHaveBeenCalledWith(expect.objectContaining({ triggerType: "CHAT_OPENED", recentMessages: [],
      serviceObservations: [history[0].text] }));
    expect(h.deliver).toHaveBeenCalledTimes(1);
    expect(await db.conversations.findById(conversation.id)).toMatchObject({ lastInboundAt: null,
      awaitingUserReply: true, followUpCount: 0, followUpAnchorAt: now,
      followUpEligibleAt: new Date(now.getTime() + 24 * 3600_000) });
    await h.workflow.observe(chat(), "owner", now); await h.workflow.processDue(now);
    expect(h.generate).toHaveBeenCalledTimes(1); expect(h.deliver).toHaveBeenCalledTimes(1);
  });
  it.each(["customer", "owner"])("never opens a chat after %s has already written", async authorId => {
    const h = setup(); await discover(h); now = new Date(now.getTime() + 120_000);
    history.push({ ...history[0], id: "human", authorId, type: "image", text: null });
    await h.workflow.processDue(now); expect(h.generate).not.toHaveBeenCalled(); expect(h.deliver).not.toHaveBeenCalled();
  });
  it("cancels a first contact if someone writes during generation", async () => {
    const h = setup(); await discover(h); now = new Date(now.getTime() + 120_000);
    h.generate.mockImplementationOnce(async () => {
      history.push({ ...history[0], id: "manual", authorId: "owner", type: "text", text: "I am already helping." });
      return { replyAction: "SEND_REPLY", text: "Hello", nextInformationNeed: null, awaitingUserReply: true,
        model: "fake", inputTokens: 0, outputTokens: 0 };
    });
    await h.workflow.processDue(now); expect(h.deliver).not.toHaveBeenCalled();
  });
  it("does not contact historical chats, other sellers, direct chats or chats without verified metadata", async () => {
    const h = setup(); await h.workflow.start("owner", start);
    for (const item of [{ ...chat(), createdAtUnix: start.getTime()/1000-1 },
      { ...chat(), listingOwnerId: "other" }, { ...chat(), contextType: "u2u" },
      { ...chat(), participantIds: [] }, { ...chat(), createdAtUnix: undefined }]) await h.workflow.observe(item, "owner", now);
    expect(await db.leads.findByExternalIdentity("AVITO", "new-chat")).toBeNull();
  });
  it("consumes a semantic NO_REPLY without repeatedly calling the model", async () => {
    const h = setup(); await discover(h); now = new Date(now.getTime()+120_000);
    h.generate.mockResolvedValue({ replyAction: "NO_REPLY", text: "", nextInformationNeed: null,
      model: "fake", inputTokens: 0, outputTokens: 0 });
    await h.workflow.processDue(now); await h.workflow.processDue(now);
    expect(h.generate).toHaveBeenCalledTimes(1); expect(h.deliver).not.toHaveBeenCalled();
  });
  it("fails closed when authoritative history cannot be read", async () => {
    const h = setup(); await discover(h); now = new Date(now.getTime()+120_000);
    h.readHistory.mockRejectedValueOnce(new Error("NETWORK"));
    await h.workflow.processDue(now); expect(h.generate).not.toHaveBeenCalled(); expect(h.deliver).not.toHaveBeenCalled();
  });
  it("keeps the activation boundary across a worker restart", async () => {
    const first = setup(); await first.workflow.start("owner", start);
    const restarted = setup(); await restarted.workflow.start("owner", new Date(start.getTime()+60_000));
    await restarted.workflow.observe(chat(), "owner", now);
    expect(await db.leads.findByExternalIdentity("AVITO", "new-chat")).not.toBeNull();
  });
  it("bounds generation failures and never sends a technical fallback", async () => {
    const h = setup(); await discover(h); h.generate.mockRejectedValue(new Error("MODEL_UNAVAILABLE"));
    now = new Date(now.getTime()+120_000);
    for (let i=0; i<5; i++) { await h.workflow.processDue(now); now = new Date(now.getTime()+300_000); }
    expect(h.generate).toHaveBeenCalledTimes(3); expect(h.deliver).not.toHaveBeenCalled();
  });
  it("retries durable delivery without regenerating the greeting", async () => {
    const h = setup(); await discover(h); now = new Date(now.getTime()+120_000);
    h.deliver.mockResolvedValueOnce({ status: "FAILED", errorCode: "AVITO_NETWORK_ERROR", retryable: true });
    await h.workflow.processDue(now); now = new Date(now.getTime()+300_000); await h.workflow.processDue(now);
    expect(h.generate).toHaveBeenCalledTimes(1); expect(h.deliver).toHaveBeenCalledTimes(2);
    expect(h.deliver.mock.calls[0]).toEqual(h.deliver.mock.calls[1]);
  });
  it("cancels a pending delivery if the manager writes before retry", async () => {
    const h = setup(); await discover(h); now = new Date(now.getTime()+120_000);
    h.deliver.mockResolvedValueOnce({ status: "FAILED", errorCode: "AVITO_NETWORK_ERROR", retryable: true });
    await h.workflow.processDue(now);
    await createExternalConversationMessageRecorder({ persistence: db })({ source: "AVITO", externalLeadId: "new-chat",
      externalMessageId: "manual", text: "I will help you", createdAt: now });
    now = new Date(now.getTime()+300_000); await h.workflow.processDue(now);
    expect(h.deliver).toHaveBeenCalledTimes(1);
    const lead = (await db.leads.findByExternalIdentity("AVITO", "new-chat"))!;
    const draft = (await db.messages.listByLeadId(lead.id)).find(m => m.actor === "AI")!;
    expect(draft).toMatchObject({ deliveryStatus: "FAILED", deliveryRetryable: false });
  });
  it("fences concurrent workers before generation", async () => {
    const a = setup(); const b = setup(); await discover(a); await b.workflow.start("owner", start);
    now = new Date(now.getTime()+120_000);
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    const result = a.generate.getMockImplementation()!;
    a.generate.mockImplementationOnce(async input => { await pending; return result(input); });
    const first = a.workflow.processDue(now);
    await vi.waitFor(() => expect(a.generate).toHaveBeenCalledTimes(1));
    await b.workflow.processDue(now); expect(b.generate).not.toHaveBeenCalled();
    release(); await first; expect(a.deliver).toHaveBeenCalledTimes(1);
  });
  it("does not mistake incomplete history or substituted previews for an empty conversation", async () => {
    const h = setup(); await discover(h); now = new Date(now.getTime()+120_000);
    history = Array.from({ length: 100 }, () => history[0]);
    await h.workflow.processDue(now); expect(h.generate).not.toHaveBeenCalled();
  });
});
