import { resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type {
  ExtractedFacts,
  ExtractedMessage,
  ExtractedSignals,
} from "@/domain/extraction/extracted-message";
import { SqlitePersistence } from "@/infrastructure/database/sqlite-persistence";
import { FakeLLMProvider } from "@/integrations/fake/fake-llm-provider";
import { FakeManagerNotificationProvider } from "@/integrations/fake/fake-manager-notification-provider";
import { FakeOutboundProvider } from "@/integrations/fake/fake-outbound-provider";
import { createInitialLead } from "../workflows/process-incoming-event";
import {
  createTestChatLabService,
  TEST_CHAT_LAB_SOURCE,
} from "./test-chat-lab-service";

function extractionReply(
  facts: Partial<ExtractedFacts> = {},
  signals: Partial<ExtractedSignals> = {},
  intent: ExtractedMessage["intent"] = "GENERAL_INTEREST",
): string {
  const extraction: ExtractedMessage = {
    intent,
    facts: {
      phoneNumber: "",
      phoneConfirmed: false,
      city: null,
      budget: null,
      budgetConfirmed: false,
      availableCapital: null,
      availableCapitalConfirmed: false,
      entryBudget: null,
      additionalLaunchCapital: null,
      capitalScope: "UNKNOWN",
      additionalExpensesReadiness: "UNKNOWN",
      businessModelReadiness: "UNKNOWN",
      calculationUnits: null,
      startingUnits: null,
      scalingPotentialUnits: null,
      hasFreeTime: null,
      availableTimeDetails: null,
      businessExperience: null,
      shortTermRentalExperience: null,
      ownsProperty: null,
      desiredIncome: null,
      primaryGoal: "UNKNOWN",
      launchTiming: null,
      managementReadiness: null,
      requiresGuaranteedIncome: null,
      rejectsBusinessModel: null,
      ...facts,
    },
    signals: {
      questions: [],
      objections: [],
      possiblePrimaryFear: null,
      possibleSecondaryFear: null,
      wantsHuman: false,
      ...signals,
    } satisfies ExtractedSignals,
    confidence: 0.9,
    uncertainty: [],
  };
  return JSON.stringify({
    ...extraction,
    facts: {
      ...extraction.facts,
      availableCapital: extraction.facts.availableCapital ?? -1,
      entryBudget: extraction.facts.entryBudget ?? -1,
      additionalLaunchCapital: extraction.facts.additionalLaunchCapital ?? -1,
      calculationUnits: extraction.facts.calculationUnits ?? -1,
    },
  });
}

function naturalReply(text = "Спасибо, продолжим.", nextInformationNeed: string | null = null): string {
  return JSON.stringify({ replyAction: "SEND_REPLY", text, nextInformationNeed });
}

const at = (hours: number) => new Date(Date.parse("2026-09-18T10:00:00.000Z") + hours * 60 * 60 * 1_000);

describe("isolated Test Chat Lab workflow", () => {
  let persistence: SqlitePersistence;

  beforeEach(async () => {
    persistence = await SqlitePersistence.createMigrated("file::memory:", resolve(process.cwd(), "drizzle"));
  });
  afterEach(() => persistence.close());

  it("uses separate extraction and conversation providers in the same real workflow", async () => {
    const extractor = new FakeLLMProvider([extractionReply({}, {
      questions: ["Как искать клиентов?"], requiresSubstantiveAnswer: true,
      knowledgeEntryIds: ["operations-guests"],
    }, "QUESTION")]);
    const brain = new FakeLLMProvider([
      JSON.stringify({ text: "", answerText: "Заявки и работу с гостями ведёт администратор команды, он же координирует горничную.",
        qualificationQuestion: "", usedKnowledgeEntryIds: ["operations-guests"] }),
      JSON.stringify({ answerIsSupported: true, answersCurrentRequest: true, optionalQuestionAppropriate: true, feedback: "" }),
    ]);
    const outbound = new FakeOutboundProvider();
    const lab = createTestChatLabService({ persistence, llmProvider: extractor, conversationLlmProvider: brain,
      outboundProvider: outbound, managerNotificationProvider: new FakeManagerNotificationProvider() });
    await lab.managerMessage("model-roles", "Здравствуйте! Отвечу на вопросы о работе команды.", at(0), "manager");
    const result = await lab.clientMessage("model-roles", "Как искать клиентов?", at(0.01), "question");
    expect(result.snapshot.lastProcessing?.responseGenerationSource).toBe("LLM");
    expect(extractor.callCount).toBe(1);
    expect(brain.callCount).toBe(2);
    expect(JSON.parse(extractor.requests[0]!.userMessage)).toHaveProperty("CURRENT_MESSAGE");
    expect(JSON.parse(brain.requests[1]!.userMessage).purpose).toBe("ANSWER_SEMANTIC_REVIEW");
    expect(outbound.requests).toHaveLength(1);
  });

  it("reviews practical advice in a multi-turn workflow before delivery and retains idempotency", async () => {
    const supported = JSON.stringify({ answerIsSupported: true, answersCurrentRequest: true,
      optionalQuestionAppropriate: true, feedback: "" });
    const llm = new FakeLLMProvider([
      extractionReply({ city: "Пермь", availableCapital: 150_000, availableCapitalConfirmed: true },
        { questions: ["Как найти объект и клиентов?"], requiresSubstantiveAnswer: true,
          knowledgeEntryIds: ["launch-process", "company-responsibilities"] }, "QUESTION"),
      JSON.stringify({ text: "", answerText: "Команда помогает подобрать объект и разместить объявления. Гостей и бронирования ведёт администратор.",
        qualificationQuestion: "", usedKnowledgeEntryIds: ["launch-process", "company-responsibilities"] }),
      supported,
      extractionReply({}, { questions: ["С чего начать"], questionKind: "CONVERSATION_META", requiresSubstantiveAnswer: true }, "QUESTION"),
      JSON.stringify({ text: "", answerText: "Первый шаг — встреча с менеджером для показа квартир в Перми.",
        qualificationQuestion: "", interpretedQuestionKind: "RECOMMENDATION", usedKnowledgeEntryIds: ["launch-process"] }),
      JSON.stringify({ answerIsSupported: false, answersCurrentRequest: true, optionalQuestionAppropriate: true,
        feedback: "Обязательная встреча и показ квартир не утверждены; первый практический шаг — подбор объекта." }),
      JSON.stringify({ text: "", answerText: "Начните с выбора подходящей квартиры при помощи команды, затем подготовьте объект к запуску.",
        qualificationQuestion: "", interpretedQuestionKind: "RECOMMENDATION", usedKnowledgeEntryIds: ["launch-process"] }),
      supported,
    ]);
    const outbound = new FakeOutboundProvider();
    const notifications = new FakeManagerNotificationProvider();
    const lab = createTestChatLabService({ persistence, llmProvider: llm,
      outboundProvider: outbound, managerNotificationProvider: notifications });
    await lab.managerMessage("reviewed-operations", "Здравствуйте! Расскажу о запуске и отвечу на Ваши вопросы.", at(0), "manager");
    const first = await lab.clientMessage("reviewed-operations", "Пермь, бюджет 150000. Как найти объект и клиентов?", at(0.01), "operations");
    expect(first.snapshot.lastProcessing?.outboundMessage).toMatch(/подобрать.*объявления.*администратор/iu);
    const next = await lab.clientMessage("reviewed-operations", "С чего начать", at(0.02), "practical");
    expect(next.snapshot.lastProcessing).toMatchObject({ responseGenerationSource: "LLM", responseFailureCode: null });
    expect(next.snapshot.lastProcessing?.outboundMessage).toMatch(/выбора.*квартиры/iu);
    expect(outbound.requests.map((request) => request.text).join(" ")).not.toMatch(/встреча|показа/iu);
    const calls = llm.callCount;
    await lab.clientMessage("reviewed-operations", "С чего начать", at(0.02), "practical");
    expect(llm.callCount).toBe(calls);
    expect(outbound.requests).toHaveLength(2);
    expect(notifications.requests).toHaveLength(0);
    expect(llm.requests.filter((request) => JSON.parse(request.userMessage).purpose === "ANSWER_SEMANTIC_REVIEW")).toHaveLength(3);
  });

  it("answers every known part of a compound request when generation is unavailable", async () => {
    const text = "Своей квартиры нет, я смогу видеть брони и сколько времени это будет отнимать?";
    const llm = new FakeLLMProvider([
      extractionReply({}, { questions: [text], requiresSubstantiveAnswer: true,
        knowledgeEntryIds: ["property-not-required", "crm-visibility", "partner-time"] }, "QUESTION"),
      new Error("MODEL_UNAVAILABLE"),
    ]);
    const lab = createTestChatLabService({ persistence, llmProvider: llm,
      outboundProvider: new FakeOutboundProvider(), managerNotificationProvider: new FakeManagerNotificationProvider() });
    const result = await lab.clientMessage("compound-operations", text, at(0), "compound");
    const answer = result.snapshot.lastProcessing?.outboundMessage ?? "";
    expect(answer).toMatch(/квартира не обязательна/iu);
    expect(answer).toMatch(/CRM.*брони/iu);
    expect(answer).toMatch(/3[–—-]4\s+час/iu);
    expect(answer).not.toMatch(/имеете в виду/iu);
  });

  it("preserves operational answers through policy failures, short follow-ups and manager continuation", async () => {
    const rejectedMove = naturalReply("Команда помогает подобрать объект. Какой бюджет у Вас на запуск?", "AVAILABLE_CAPITAL");
    const rejectedReferral = naturalReply("С чего начать, лучше обсудить с менеджером.");
    const llm = new FakeLLMProvider([
      extractionReply({ city: "Пермь", availableCapital: 100_000, availableCapitalConfirmed: true }),
      naturalReply("По предварительному ориентиру запуск одного объекта стоит около 150 000 ₽, смета зависит от квартиры."),
      extractionReply({ availableCapital: 150_000, availableCapitalConfirmed: true }, {}, "CORRECTION"),
      naturalReply("Когда Вы хотели бы начать?", "LAUNCH_TIMING"),
      extractionReply({}, { questions: ["Как вести объект?", "Как найти объект?", "Как найти клиентов?"],
        previousQuestionResponse: "CHANGED_TOPIC", requiresSubstantiveAnswer: true,
        knowledgeEntryIds: ["company-responsibilities", "operations-guests"] }, "QUESTION"),
      rejectedMove, rejectedMove,
      extractionReply({}, { questions: ["С чего начать"], requiresSubstantiveAnswer: true,
        knowledgeEntryIds: ["launch-process"] }, "QUESTION"),
      rejectedReferral, rejectedReferral,
      extractionReply({}, { questions: ["А гости сами будут мне звонить?"], requiresSubstantiveAnswer: true,
        knowledgeEntryIds: ["operations-guests"] }, "QUESTION"),
      new Error("MODEL_UNAVAILABLE"),
    ]);
    const notifications = new FakeManagerNotificationProvider();
    const outbound = new FakeOutboundProvider();
    const lab = createTestChatLabService({ persistence, llmProvider: llm, outboundProvider: outbound, managerNotificationProvider: notifications });
    await lab.managerMessage("operations-regression", "Здравствуйте! В каком городе и с каким бюджетом рассматриваете запуск?", at(0), "manager-start");
    await lab.clientMessage("operations-regression", "Пермь\n100000", at(0.01), "capital");
    const corrected = await lab.clientMessage("operations-regression", "Тогда 150000", at(0.02), "correction");
    expect(corrected.snapshot.qualification.status).not.toBe("NO_FIT");
    const operations = await lab.clientMessage("operations-regression", "Хотелось бы сначала понять как вести объект, как найти его и клиентов", at(0.03), "operations");
    const firstAnswer = operations.snapshot.lastProcessing?.outboundMessage ?? "";
    expect(firstAnswer).toMatch(/подбор|подобрать|поиск/iu);
    expect(firstAnswer).toMatch(/реклам|объявлен/iu);
    expect(firstAnswer).toMatch(/гост|бронирован/iu);
    expect(firstAnswer).not.toMatch(/что.*имеете в виду|какой бюджет|когда.*начать/iu);
    const next = await lab.clientMessage("operations-regression", "С чего начать", at(0.04), "next-step");
    expect(next.snapshot.lastProcessing?.outboundMessage).toMatch(/подобрать объект/iu);
    expect(next.snapshot.lastProcessing?.outboundMessage).not.toBe(firstAnswer);
    await lab.managerMessage("operations-regression", "Команда ведёт операционную работу, а детали обсудим при выборе объекта.", at(0.05), "manager-help");
    const continued = await lab.clientMessage("operations-regression", "А гости сами будут мне звонить?", at(0.06), "guests");
    expect(continued.snapshot.lastProcessing?.outboundMessage).toMatch(/администратор/iu);
    expect(continued.snapshot.messages.filter((m) => m.actor === "MANAGER")).toHaveLength(2);
    expect(outbound.requests).toHaveLength(5);
    expect(notifications.requests).toHaveLength(0);
    const callsBeforeDuplicate = llm.callCount;
    await lab.clientMessage("operations-regression", "А гости сами будут мне звонить?", at(0.06), "guests");
    expect(llm.callCount).toBe(callsBeforeDuplicate);
    expect(outbound.requests).toHaveLength(5);
  });

  async function handedOffSession(replies: string[]) {
    const facts: Partial<ExtractedFacts> = {
      city: "Москва", availableCapital: 300_000, availableCapitalConfirmed: true,
      businessModelReadiness: "ACCEPTS", additionalExpensesReadiness: "READY",
      primaryGoal: "EARN_INCOME", launchTiming: "READY_NOW", managementReadiness: "READY",
    };
    const llm = new FakeLLMProvider([
      extractionReply(facts), naturalReply("Здравствуйте! На какой номер менеджер может Вам позвонить?", "PHONE_NUMBER"),
      extractionReply({ phoneNumber: "+79991234567", phoneConfirmed: true }),
      extractionReply({}, { previousQuestionResponse: "ANSWERED" }, "CONFIRMATION"),
      JSON.stringify({ text: "Менеджер свяжется с Вами, чтобы обсудить запуск.",
        conversationMemory: "Контакт передан. Время клиент согласует с менеджером. Диалог завершён." }),
      ...replies,
    ]);
    const outbound = new FakeOutboundProvider();
    const notifications = new FakeManagerNotificationProvider();
    const lab = createTestChatLabService({ persistence, llmProvider: llm,
      outboundProvider: outbound, managerNotificationProvider: notifications });
    await lab.clientMessage("closing-regression", "Москва, есть 300 тысяч, готов запускаться", at(0), "start");
    await lab.clientMessage("closing-regression", "+79991234567", at(0), "phone");
    await lab.clientMessage("closing-regression", "Время с менеджером согласую", at(0), "callback");
    expect(notifications.requests).toHaveLength(1);
    return { lab, llm, outbound, notifications };
  }

  it.each([{}, { city: "Москва", availableCapital: 300_000, availableCapitalConfirmed: true }])(
    "respects a contextual no-reply after handoff despite extraction defaults or repeated facts: %j",
    async (facts) => {
      const { lab, outbound, notifications } = await handedOffSession([
        extractionReply(facts, { previousQuestionResponse: "ANSWERED" }, "CONFIRMATION"),
        JSON.stringify({ replyAction: "NO_REPLY", text: "", conversationAction: "NO_REPLY" }),
      ]);
      const sentBefore = outbound.requests.length;
      const result = await lab.clientMessage("closing-regression", "Прекрасно", at(0), "closing");
      expect(result.snapshot.lastProcessing).toMatchObject({
        outboundMessage: null, replyAction: "NO_REPLY", responseGenerationSource: "NO_REPLY",
      });
      expect(result.snapshot.replyAction).toBe("NO_REPLY");
      expect(outbound.requests).toHaveLength(sentBefore);
      expect(notifications.requests).toHaveLength(1);
    },
  );

  it("reopens a completed conversation for questions about the AI's own wording without another handoff", async () => {
    const noReply = JSON.stringify({ replyAction: "NO_REPLY", text: "", conversationAction: "NO_REPLY" });
    const { lab, llm, outbound, notifications } = await handedOffSession([
      extractionReply({}, {}, "CONFIRMATION"), naturalReply("Понял, учту."),
      extractionReply({}, { questionKind: "CONVERSATION_META", requiresSubstantiveAnswer: true,
        questions: ["Что именно учтёшь?"] }, "QUESTION"),
      noReply, naturalReply("Неудачно выразился: новых пожеланий Вы не сообщали, записывать здесь нечего."),
      extractionReply({}, { questionKind: "NONE", requiresSubstantiveAnswer: true }, "QUESTION"),
      noReply, JSON.stringify({ text: "Я лишь отреагировал на Ваше согласие. Про учёт написал не к месту, извините.", conversationAction: "REPAIR" }),
    ]);
    await lab.clientMessage("closing-regression", "Прекрасно", at(0), "closing");
    for (const [turn, text] of [
      ["question", "Что именно учтёшь?"],
      ["clarification", "ты мне написал типа понял учту, это к чему было?"],
    ]) {
      const result = await lab.clientMessage("closing-regression", text!, at(0), turn);
      expect(result.snapshot.lastProcessing).toMatchObject({ responseGenerationSource: "LLM", responseFailureCode: null });
      expect(result.snapshot.lastProcessing?.outboundMessage).not.toMatch(/уточните|что.*имеете в виду/iu);
    }
    const retried = llm.requests.map((r) => JSON.parse(r.userMessage))
      .filter((r) => r.validationFeedback);
    expect(retried).toHaveLength(2);
    expect(retried[0].currentExchange.previousSpeakerTurn).toBe("Понял, учту.");
    expect(retried[0].currentExchange.previousUserTurn).toEqual(["Прекрасно"]);
    expect(retried[1].currentExchange.activeUserTurn).toContain("ты мне написал типа понял учту, это к чему было?");
    expect(outbound.requests).toHaveLength(6);
    expect(notifications.requests).toHaveLength(1);
  });

  it("shows the open conversation when an older one closed at the same virtual time", async () => {
    const lead = createInitialLead("lead-snapshot", TEST_CHAT_LAB_SOURCE, "session-snapshot", at(0));
    await persistence.leads.insert(lead);
    const base = {
      leadId: lead.id,
      summary: null,
      pendingInformationNeed: null,
      lastInboundAt: at(0),
      lastOutboundAt: null,
      awaitingUserReply: false,
      qualificationCompleted: false,
      followUpEligibleAt: null,
      followUpCount: 0,
      lastFollowUpAt: null,
      nextInboundSequence: 0,
      lastAppliedInboundSequence: 0,
      createdAt: at(0),
      updatedAt: at(0),
    } as const;
    await persistence.conversations.insert({
      ...base,
      id: "closed-snapshot",
      state: "CLOSED",
      closedAt: at(0),
    });
    await persistence.conversations.insert({
      ...base,
      id: "open-snapshot",
      state: "WAITING_GOAL",
      pendingInformationNeed: "GOAL",
      closedAt: null,
    });
    const message = {
      leadId: lead.id,
      incomingEventId: null,
      externalMessageId: null,
      deduplicationKey: null,
      direction: "OUTBOUND" as const,
      actor: "AI" as const,
      deliveryStatus: "SENT" as const,
      deliveryAttempts: 1,
      deliveryRetryable: false,
      lastDeliveryErrorCode: null,
      sentAt: at(0),
      createdAt: at(0),
      sequence: null,
    };
    await persistence.messages.insert({
      ...message,
      id: "old-snapshot-message",
      conversationId: "closed-snapshot",
      content: "Первый эпизод разговора",
    });
    await persistence.messages.insert({
      ...message,
      id: "new-snapshot-message",
      conversationId: "open-snapshot",
      content: "Продолжение разговора",
    });
    const lab = createTestChatLabService({
      persistence,
      llmProvider: new FakeLLMProvider([]),
      outboundProvider: new FakeOutboundProvider(),
      managerNotificationProvider: new FakeManagerNotificationProvider(),
    });

    const snapshot = await lab.snapshot("session-snapshot");

    expect(snapshot.conversation).toMatchObject({ id: "open-snapshot", state: "WAITING_GOAL" });
    expect(snapshot.currentNextStep).toBe("GOAL");
    expect(snapshot.messages.map((entry) => entry.content)).toEqual([
      "Первый эпизод разговора",
      "Продолжение разговора",
    ]);
  });

  it("treats a rapid greeting, city and capital as one turn with one reply", async () => {
    const llm = new FakeLLMProvider([
      extractionReply(),
      extractionReply({ city: "Нижний Новгород" }),
      extractionReply({ city: "Нижний Новгород", availableCapital: 100_000, availableCapitalConfirmed: true }),
    ]);
    const lab = createTestChatLabService({
      persistence,
      llmProvider: llm,
      outboundProvider: new FakeOutboundProvider(),
      managerNotificationProvider: new FakeManagerNotificationProvider(),
    });

    const result = await lab.runScenario("burst-session", "city-and-insufficient-capital", at(0));
    const userMessages = result.snapshot.messages.filter((message) => message.actor === "USER");
    const aiMessages = result.snapshot.messages.filter((message) => message.actor === "AI");
    expect(userMessages).toHaveLength(3);
    expect(aiMessages).toHaveLength(1);
    expect(result.snapshot.lead).toMatchObject({
      city: "Нижний Новгород",
      availableCapital: 100_000,
    });
    expect(aiMessages[0]?.content).not.toMatch(/какой бюджет|сколько готовы вложить/iu);
  });

  it("keeps Dmitry and client in one history and persists an early phone without qualification questioning", async () => {
    const llm = new FakeLLMProvider([
      extractionReply(),
      JSON.stringify({ replyAction: "NO_REPLY", text: "", nextInformationNeed: null }),
    ]);
    const outbound = new FakeOutboundProvider();
    const notifications = new FakeManagerNotificationProvider();
    const lab = createTestChatLabService({
      persistence,
      llmProvider: llm,
      outboundProvider: outbound,
      managerNotificationProvider: notifications,
    });

    await lab.managerMessage("session-1", "Оставьте номер, я вам сегодня наберу.", at(0), "manager-1");
    const result = await lab.clientMessage("session-1", "89049163020", at(0), "client-1");
    const lead = await persistence.leads.findByExternalIdentity(TEST_CHAT_LAB_SOURCE, "session-1");
    const conversation = lead ? await persistence.conversations.findOpenByLeadId(lead.id) : null;
    const messages = conversation ? await persistence.messages.listByConversationId(conversation.id) : [];

    expect(result.snapshot.phone).toBe("+79049163020");
    expect(result.snapshot.replyAction).toBe("NO_REPLY");
    expect(result.snapshot.currentNextStep).toBe("MANAGER_DEFINED_NEXT_STEP");
    expect(messages.map((message) => [message.actor, message.content])).toEqual([
      ["MANAGER", "Оставьте номер, я вам сегодня наберу."],
      ["USER", "89049163020"],
    ]);
    expect(lead?.qualificationStatus).not.toBe("HOT");
    expect(outbound.requests).toHaveLength(0);
    expect(notifications.requests).toHaveLength(0);
  });

  it("uses the real follow-up workflow when virtual time advances and sends at most one follow-up", async () => {
    const llm = new FakeLLMProvider([
      extractionReply(),
      naturalReply("Подскажите, в каком городе рассматриваете запуск?", "CITY"),
      naturalReply("Вернусь к нашему вопросу о запуске: актуально обсудить формат?", null),
    ]);
    const outbound = new FakeOutboundProvider();
    const lab = createTestChatLabService({
      persistence,
      llmProvider: llm,
      outboundProvider: outbound,
      managerNotificationProvider: new FakeManagerNotificationProvider(),
    });

    await lab.clientMessage("session-2", "Хочу разобраться с запуском.", at(0), "client-1");
    const before = await lab.snapshot("session-2");
    expect(before.followUp.eligibleAt).not.toBeNull();

    const after = await lab.advanceTime("session-2", at(2));
    expect(after.followUp?.sent).toBe(1);
    expect(after.snapshot.followUp.followUpCount).toBe(1);
    expect(outbound.requests).toHaveLength(2);

    const second = await lab.advanceTime("session-2", at(4));
    expect(second.followUp?.sent).toBe(0);
    expect(outbound.requests).toHaveLength(2);
  });

  it("does not replay an explained business overview when the client answers with a city", async () => {
    const businessOverview = "Команда помогает подобрать и запустить объект, вести объявления, бронирования и работу с гостями.";
    const llm = new FakeLLMProvider([
      extractionReply({}, {
        questions: ["Расскажите подробнее"],
        requiresSubstantiveAnswer: true,
      }, "QUESTION"),
      JSON.stringify({
        replyAction: "SEND_REPLY",
        text: `${businessOverview} В каком городе Вы планируете запуск?`,
        nextInformationNeed: "CITY",
        conversationAction: "ANSWER",
        qualificationMoveDecision: "ADVANCE",
        qualificationMoveRationale: "после ответа естественно уточнить город",
        answerCoverage: "FULL",
        unresolvedTopics: [],
        usedKnowledgeEntryIds: ["company-responsibilities"],
      }),
      extractionReply({}, {
        questions: ["Расскажите подробнее"],
        previousQuestionResponse: "DECLINED_TO_ANSWER",
        requiresSubstantiveAnswer: true,
      }, "QUESTION"),
      extractionReply({ city: "Москва" }, {
        questions: [],
        previousQuestionResponse: "ANSWERED",
        requiresSubstantiveAnswer: false,
      }, "QUALIFICATION_INFORMATION"),
      JSON.stringify({
        replyAction: "SEND_REPLY",
        text: "Москва, понял. Какой бюджет в целом Вы готовы выделить на запуск?",
        nextInformationNeed: "AVAILABLE_CAPITAL",
        conversationAction: "DISCOVER",
        qualificationMoveDecision: "ADVANCE",
        qualificationMoveRationale: "город принят, следующий полезный факт — бюджет",
        answerCoverage: "FULL",
        unresolvedTopics: [],
        usedKnowledgeEntryIds: [],
      }),
    ]);
    const outbound = new FakeOutboundProvider();
    const lab = createTestChatLabService({
      persistence,
      llmProvider: llm,
      outboundProvider: outbound,
      managerNotificationProvider: new FakeManagerNotificationProvider(),
    });

    await lab.clientMessage("session-repeat", "Расскажите подробнее", at(0), "client-1");
    const result = await lab.clientMessage("session-repeat", "Москва", at(0), "client-2");
    const lead = await persistence.leads.findByExternalIdentity(
      TEST_CHAT_LAB_SOURCE,
      "session-repeat",
    );

    expect(llm.callCount).toBe(5);
    expect(lead?.city).toBe("Москва");
    expect(outbound.requests).toHaveLength(2);
    expect(outbound.requests[1]?.text).toContain("Москва");
    expect(outbound.requests[1]?.text).not.toContain(businessOverview);
    expect(result.snapshot.messages.filter((message) => message.actor === "AI"))
      .toHaveLength(2);
  });
});
