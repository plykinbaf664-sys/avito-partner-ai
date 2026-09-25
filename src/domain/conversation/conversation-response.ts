import {
  isFreshDiscoveryLead,
  type InformationNeed,
  type InformationNeedsAssessment,
} from "./information-needs";
import type { ExtractedMessage } from "../extraction/extracted-message";
import type { MessageIntent } from "../extraction/extracted-message";
import type { Lead } from "../lead/lead";
import {
  asksForPreferredCallbackTime,
  preferredContactTimeFromQuestions,
} from "../lead/preferred-contact-time";
import type {
  QualificationDecision,
  QualificationReasonCode,
} from "../qualification/qualification-policy";
import type {
  ApprovedKnowledgeFact,
  KnowledgeAnswer,
} from "../knowledge/knowledge-base";
import {
  buildApprovedEconomicsContext,
  type ApprovedEconomicsContext,
} from "../economics/economics-calculator";

const qualificationQuestions: Record<InformationNeed, string> = {
  PHONE_NUMBER:
    "Оставьте, пожалуйста, номер телефона, чтобы менеджер мог с вами связаться.",
  AVAILABLE_CAPITAL:
    "Какой бюджет в целом вы готовы выделить на запуск бизнеса?",
  ADDITIONAL_EXPENSES:
    "Готовы ли вы отдельно учитывать расходы по самому объекту — например залог, оснащение и обслуживание? Точную сумму сейчас называть не нужно.",
  BUSINESS_MODEL:
    "Подходит ли вам формат собственного бизнеса на посуточной аренде с поддержкой нашей команды?",
  LAUNCH_TIMING: "Когда примерно вы рассматриваете запуск?",
  CITY: "В каком городе вы планируете запускать объекты?",
  STARTING_UNITS: "Со скольких объектов хотите начать?",
  SCALING_POTENTIAL_UNITS: "До какого количества объектов в перспективе готовы масштабироваться?",
  GOAL: "Какую главную цель хотите решить этим бизнесом?",
  MANAGEMENT_READINESS:
    "Готовы участвовать в запуске: ездить на просмотры, заключать договоры аренды и принимать ключевые решения?",
  FREE_TIME: "Сможете уделять проекту примерно 3–4 часа в день?",
  EXPERIENCE: "Есть ли у вас опыт в бизнесе или посуточной аренде?",
  BARRIER: "Что сейчас больше всего останавливает или вызывает сомнения?",
};

const qualificationObjectives: Record<InformationNeed, string> = {
  PHONE_NUMBER: "получить номер для связи только после достаточной квалификации",
  AVAILABLE_CAPITAL: "понять общий бюджет, который человек готов вложить в запуск бизнеса",
  ADDITIONAL_EXPENSES: "понять готовность нести расходы самого объекта сверх услуги запуска",
  BUSINESS_MODEL: "понять готовность запускать собственный бизнес по посуточной аренде с поддержкой команды",
  CITY: "узнать город предполагаемого запуска",
  LAUNCH_TIMING: "понять реальный горизонт запуска",
  FREE_TIME: "понять возможность уделять проекту ориентировочно 3–4 часа в день",
  MANAGEMENT_READINESS: "понять готовность лично участвовать в необходимых действиях по запуску",
  STARTING_UNITS: "понять желаемое число объектов на старте",
  SCALING_POTENTIAL_UNITS: "понять желаемый масштаб в перспективе",
  GOAL: "понять цель и мотивацию человека",
  EXPERIENCE: "узнать релевантный опыт без превращения разговора в анкету",
  BARRIER: "понять главное сомнение или препятствие",
};

// These are customer-facing drafts. Qualification reason codes select the
// policy branch, but are deliberately never used as customer copy.
const customerFacingRejectionDrafts: Partial<Record<QualificationReasonCode, string>> = {
  NO_LAUNCH_CAPITAL:
    "Для запуска в этой модели нужен собственный капитал на услугу команды, аренду, залог и подготовку объекта. Без доступных средств начать сейчас не получится. Если финансовая ситуация изменится, можно вернуться к разговору.",
  NO_LAUNCH_INTENT:
    "Понял. Раз запуск вы сейчас не рассматриваете, не буду продолжать разговор. Если планы изменятся, можно вернуться к нему.",
  NO_MANAGEMENT_INTERACTION:
    "Понял. Для запуска партнёру всё же нужно участвовать в просмотрах, заключении договоров и ключевых решениях, поэтому сейчас формат вам не подойдёт.",
  DECLINED_BY_LEAD:
    "Понял, спасибо за прямой ответ. Не буду больше отвлекать. Если интерес вернётся, можно продолжить разговор.",
  REQUIRES_INCOME_GUARANTEE:
    "Компания не гарантирует доход или прибыль. Если гарантия является обязательным условием, текущий формат вам не подойдёт.",
  INCOMPATIBLE_BUSINESS_MODEL:
    "Понял. Судя по вашему условию, текущая модель бизнеса вам не подходит, поэтому не буду продолжать разговор по этому формату.",
  UNWILLING_TO_FUND_REQUIRED_EXPENSES:
    "Помимо услуги команды, для запуска нужно самостоятельно оплатить аренду, залог и базовую комплектацию объекта. Вы указали, что не готовы финансировать эти обязательные расходы, поэтому в текущем формате запуск не получится.",
};

function formatMoney(value: number): string {
  return `${value.toLocaleString("ru-RU").replaceAll("\u00a0", " ")} ₽`;
}

function customerFacingInsufficientCapitalDraft(
  economics: ApprovedEconomicsContext | undefined,
): string {
  const scenario = economics?.scenarios.find((candidate) =>
    candidate.requestedUnitsLaunch !== null || candidate.oneObjectLaunch !== null,
  );
  const launch = scenario?.requestedUnitsLaunch ?? scenario?.oneObjectLaunch;
  const capital = economics?.availableCapital;
  if (!scenario || !launch || capital === null || capital === undefined) {
    return "По текущему расчётному ориентиру бюджета может не хватить для запуска выбранного объёма. В расчёт входят услуга запуска, аренда, залог и подготовка объекта; точная смета зависит от квартиры и условий собственника.";
  }
  const total = launch.totalMin === launch.totalMax
    ? formatMoney(launch.totalMin)
    : `примерно ${formatMoney(launch.totalMin)}–${formatMoney(launch.totalMax)}`;
  const units = launch.units === 1 ? "одного объекта" : `${launch.units} объектов`;
  return `Для предварительного расчёта запуск ${units} потребует ${total}: сюда входят услуга запуска, аренда, залог за один месяц и подготовка. У вас ${formatMoney(capital)}, поэтому по этому расчёту суммы пока не хватает. Фактическая смета зависит от квартиры и условий собственника.`;
}

function compactGuidanceDraft(
  guidanceNeed: InformationNeed | null | undefined,
  economics: ApprovedEconomicsContext | undefined,
): string | null {
  if (guidanceNeed !== "STARTING_UNITS" || !economics) return null;
  const scenario = economics.scenarios.find(
    (candidate) => candidate.affordableObjectCount !== null,
  );
  const estimate = scenario?.affordableObjectCount;
  if (!scenario || !estimate || economics.availableCapital === null) return null;
  const maxUnits = estimate.maxUnitsAtMinCost;
  const unitsLabel = maxUnits === 1 ? "1 объекта" : `${maxUnits} объектов`;
  const capital = economics.availableCapital
    .toLocaleString("ru-RU")
    .replaceAll("\u00a0", " ");
  return `При бюджете ${capital} ₽ по сценарию «${scenario.label}» можно рассмотреть запуск до ${unitsLabel}. Это ориентир: точная смета зависит от квартиры, аренды и условий по залогу.`;
}

function compactContextualEconomicsDraft(
  extraction: ExtractedMessage,
  economics: ApprovedEconomicsContext | undefined,
  contextualReferenceResolved = false,
): string | null {
  if (
    !economics ||
    (!extraction.signals.contextualReference && !contextualReferenceResolved) ||
    extraction.signals.questions.length === 0
  ) {
    return null;
  }
  const scenario = economics.scenarios.find((candidate) => candidate.oneObjectLaunch !== null);
  const launch = scenario?.oneObjectLaunch;
  if (!scenario || !launch) return null;
  const format = (value: number) => value.toLocaleString("ru-RU").replaceAll("\u00a0", " ");
  const range = launch.totalMin === launch.totalMax
    ? `${format(launch.totalMin)} ₽`
    : `примерно ${format(launch.totalMin)}–${format(launch.totalMax)} ₽`;
  return `По этому ориентиру запуск одного объекта — ${range}. В расчёте учтены услуга запуска, аренда, расчётный залог и базовая подготовка; фактический залог зависит от объекта и собственника.`;
}

export interface ConversationResponsePlan {
  text: string;
  nextInformationNeed: InformationNeed | null;
  asksUserQuestion: boolean;
  knowledgeEntryIds: string[];
  unresolvedQuestions: string[];
  useNaturalAdaptation: boolean;
  contextualReference?: boolean;
  allowedNextInformationNeeds?: InformationNeed[];
  allowedNextQuestions?: Array<{
    need: InformationNeed;
    question: string;
  }>;
  knownFacts?: InformationNeed[];
  missingCriticalFacts?: InformationNeed[];
  missingOptionalFacts?: InformationNeed[];
  qualificationReasonCodes?: QualificationReasonCode[];
  preferDiscoveryContext?: boolean;
  postHandoffContinuation?: boolean;
  economicsContext?: ApprovedEconomicsContext;
  approvedFacts?: ApprovedKnowledgeFact[];
  currentUserIntent?: MessageIntent;
  currentUserQuestions?: string[];
  currentQuestionKind?: ExtractedMessage["signals"]["questionKind"];
  previousQuestionResponse?: string;
  greetingRequired?: boolean;
  currentUserObjections?: string[];
  currentUncertainty?: string[];
  conversationRepairRequired?: boolean;
  previouslyExplainedKnowledgeEntryIds?: string[];
  allowedQualificationMoves?: Array<{
    need: InformationNeed;
    objective: string;
  }>;
  /** Policy requires progress, while Claude still chooses the topic and wording. */
  qualificationProgressExpected?: boolean;
  deferredInformationNeeds?: InformationNeed[];
  guidanceNeed?: InformationNeed | null;
  groundedAnswerRequired?: boolean;
  currentTurnRequiresAnswer?: boolean;
  customerFacingDecision?: "CONTINUE" | "REJECT" | "HANDOFF";
  customerFacingDecisionReason?: QualificationDecision["reason"];
  serviceabilityStatus?: Lead["serviceability"];
  preferredContactTime?: string | null;
  callbackPreferenceCaptured?: boolean;
  /** Reliability of the auxiliary extractor for the current inbound turn. */
  extractionQuality?: "VALID" | "RECOVERED" | "DEGRADED";
}

const qualificationProgressIntents = new Set<MessageIntent>([
  "GREETING",
  "GENERAL_INTEREST",
  "QUALIFICATION_INFORMATION",
  "QUESTION",
  "CONFIRMATION",
  "CORRECTION",
  "COMPLAINT",
]);

function expectsQualificationProgress(params: {
  intent: MessageIntent;
  decision: QualificationDecision;
  allowedNextInformationNeeds: InformationNeed[];
  postHandoffContinuation: boolean;
}): boolean {
  return (
    params.decision.nextAction === "CONTINUE_QUALIFICATION" &&
    params.allowedNextInformationNeeds.length > 0 &&
    !params.postHandoffContinuation &&
    qualificationProgressIntents.has(params.intent)
  );
}

export function buildConversationResponse(params: {
  lead: Lead;
  extraction: ExtractedMessage;
  decision: QualificationDecision;
  nextInformationNeed: InformationNeed | null;
  knowledge: KnowledgeAnswer;
  informationNeeds?: InformationNeedsAssessment;
  previouslyExplainedKnowledgeEntryIds?: readonly string[];
  deferredInformationNeeds?: readonly InformationNeed[];
  guidanceNeed?: InformationNeed | null;
  greetingRequired?: boolean;
  callbackPreferenceCaptured?: boolean;
  extractionQuality?: "VALID" | "RECOVERED" | "DEGRADED";
}): ConversationResponsePlan {
  const { extraction, decision, nextInformationNeed, knowledge } = params;
  const responseEconomics = knowledge.economicsContext ??
    (decision.reason === "INSUFFICIENT_LAUNCH_CAPITAL"
      ? buildApprovedEconomicsContext({
          availableCapital: params.lead.availableCapital,
          city: params.lead.city,
          requestedUnits: params.lead.startingUnits,
        })
      : undefined);
  const conversationRepairRequired = extraction.intent === "COMPLAINT";
  const candidateNextInformationNeeds =
    params.informationNeeds?.allowedNextInformationNeeds ??
    (nextInformationNeed === null ? [] : [nextInformationNeed]);
  const allowedNextInformationNeeds = candidateNextInformationNeeds;
  const preferDiscoveryContext = isFreshDiscoveryLead(params.lead);
  const postHandoffContinuation = params.lead.handoffAt !== null;
  const preferredContactTime = preferredContactTimeFromQuestions(
    params.lead.questions,
  );
  const qualificationProgressExpected = expectsQualificationProgress({
    intent: extraction.intent,
    decision,
    allowedNextInformationNeeds,
    postHandoffContinuation,
  });
  const currentTurnRequiresAnswer =
    extraction.intent === "QUESTION" ||
    extraction.signals.questions.length > 0 ||
    extraction.signals.requiresSubstantiveAnswer === true ||
    params.guidanceNeed != null;
  // Whether the user deserves an answer is determined by the semantic function
  // of this turn. Literal KB matching only supplies convenient fragments; it
  // must never decide whether Claude may answer from the full approved context.
  // A question about the conversation itself needs an honest conversational
  // answer, not a forced citation to a business-knowledge entry.
  const groundedAnswerRequired = currentTurnRequiresAnswer &&
    extraction.signals.questionKind !== "CONVERSATION_META" &&
    extraction.signals.questionKind !== "AGENT_IDENTITY";
  const customerFacingDecision: ConversationResponsePlan["customerFacingDecision"] =
    decision.nextAction === "REJECT_POLITELY"
      ? "REJECT"
      : decision.shouldHandoffToManager
        ? "HANDOFF"
        : "CONTINUE";
  const previouslyExplainedKnowledgeEntryIds = new Set(
    params.previouslyExplainedKnowledgeEntryIds ?? [],
  );
  // Approved knowledge remains available to Claude, but a previously explained
  // topic must not become default copy for an ordinary qualification answer.
  // A new question/clarification may legitimately revisit the same topic.
  const knowledgeEntryIdsForCurrentTurn = currentTurnRequiresAnswer
    ? knowledge.entryIds
    : knowledge.entryIds.filter(
        (entryId) => !previouslyExplainedKnowledgeEntryIds.has(entryId),
      );
  const answerFragmentsForCurrentTurn = knowledge.answerFragments.filter(
    (_fragment, index) => {
      const entryId = knowledge.entryIds[index];
      return entryId === undefined || knowledgeEntryIdsForCurrentTurn.includes(entryId);
    },
  );
  const adaptiveContext = {
    allowedNextInformationNeeds,
    allowedNextQuestions: allowedNextInformationNeeds.map((need) => ({
      need,
      question: questionForInformationNeed(need, params.lead),
    })),
    allowedQualificationMoves: allowedNextInformationNeeds.map((need) => ({
      need,
      objective: qualificationObjectiveForInformationNeed(need),
    })),
    knownFacts: params.informationNeeds?.knownFacts ?? [],
    missingCriticalFacts: params.informationNeeds?.missingCriticalFacts ?? [],
    missingOptionalFacts: params.informationNeeds?.missingOptionalFacts ?? [],
    qualificationReasonCodes: decision.reasonCodes,
    preferDiscoveryContext,
    postHandoffContinuation,
    currentUserIntent: extraction.intent,
    currentUserQuestions: extraction.signals.questions,
    currentQuestionKind: extraction.signals.questionKind ?? "BUSINESS_INFORMATION",
    previousQuestionResponse: extraction.signals.previousQuestionResponse ?? "NOT_A_RESPONSE",
    greetingRequired: params.greetingRequired === true,
    currentUserObjections: extraction.signals.objections,
    currentUncertainty: extraction.uncertainty,
    conversationRepairRequired,
    previouslyExplainedKnowledgeEntryIds: [
      ...new Set(params.previouslyExplainedKnowledgeEntryIds ?? []),
    ],
    qualificationProgressExpected,
    deferredInformationNeeds: [...new Set(params.deferredInformationNeeds ?? [])],
    guidanceNeed: params.guidanceNeed ?? null,
    groundedAnswerRequired,
    currentTurnRequiresAnswer,
    preferredContactTime,
    callbackPreferenceCaptured: params.callbackPreferenceCaptured === true,
    extractionQuality: params.extractionQuality ?? "VALID",
    customerFacingDecision,
    customerFacingDecisionReason: decision.reason,
    serviceabilityStatus: params.lead.serviceability,
  };

  if (extraction.signals.questionKind === "AGENT_IDENTITY") {
    return {
      text: "Да, сейчас Вы общаетесь с AI-консультантом. Я помогу разобраться с вопросами о запуске, а если Вам удобнее разговор с человеком, передам обращение менеджеру.",
      nextInformationNeed: null,
      asksUserQuestion: false,
      knowledgeEntryIds: [],
      unresolvedQuestions: [],
      useNaturalAdaptation: false,
      contextualReference: false,
      ...adaptiveContext,
      economicsContext: undefined,
      approvedFacts: knowledge.approvedFacts,
    };
  }

  if (decision.nextAction === "REJECT_POLITELY") {
    const compactRejectedAnswer = compactGuidanceDraft(
      params.guidanceNeed,
      responseEconomics,
    ) ?? compactContextualEconomicsDraft(
      extraction,
      responseEconomics,
      knowledge.contextualReferenceResolved,
    );
    const customerFacingDecisionDraft = decision.reason === "INSUFFICIENT_LAUNCH_CAPITAL"
      ? customerFacingInsufficientCapitalDraft(responseEconomics)
      : customerFacingRejectionDrafts[decision.reason] ??
        "К сожалению, текущий формат вам не подойдёт. Спасибо за разговор.";
    const answeredThenRejected = [
      ...(compactRejectedAnswer
        ? [compactRejectedAnswer]
        : answerFragmentsForCurrentTurn.slice(0, 2)),
      customerFacingDecisionDraft,
    ];
    return {
      text: answeredThenRejected.join(" "),
      nextInformationNeed: null,
      asksUserQuestion: false,
      knowledgeEntryIds: knowledgeEntryIdsForCurrentTurn,
      unresolvedQuestions: [],
      // The policy owns rejection, not the wording. A model can explain the
      // approved economics naturally even when no KB fragment matched.
      useNaturalAdaptation: true,
      contextualReference: knowledge.contextualReferenceResolved,
      ...adaptiveContext,
      economicsContext: responseEconomics,
      approvedFacts: knowledge.approvedFacts,
    };
  }

  const guidanceDraft = compactGuidanceDraft(
    params.guidanceNeed,
    responseEconomics,
  );
  const contextualEconomicsDraft = compactContextualEconomicsDraft(
    extraction,
    responseEconomics,
    knowledge.contextualReferenceResolved,
  );
  const parts = conversationRepairRequired
    ? ["Вы правы, предыдущий ответ был неудачным. Продолжу с учётом вашего сообщения."]
    : guidanceDraft
      ? [guidanceDraft]
      : contextualEconomicsDraft
        ? [contextualEconomicsDraft]
        : extraction.signals.contextualReference === true &&
            !knowledge.contextualReferenceResolved
          ? []
          : answerFragmentsForCurrentTurn.slice(0, 2);
  const asksCallTime =
    preferredContactTime === null &&
    params.lead.handoffAt !== null &&
    params.extraction.signals.questions.some(asksForPreferredCallbackTime);
  if (asksCallTime) {
    parts.splice(0, parts.length, "\u041c\u0435\u043d\u0435\u0434\u0436\u0435\u0440 \u0441\u0432\u044f\u0436\u0435\u0442\u0441\u044f \u0441 \u0432\u0430\u043c\u0438. \u041d\u0430\u043f\u0438\u0448\u0438\u0442\u0435, \u043f\u043e\u0436\u0430\u043b\u0443\u0439\u0441\u0442\u0430, \u0432 \u043a\u0430\u043a\u043e\u0439 \u0434\u0435\u043d\u044c \u0438 \u043f\u0440\u0438\u043c\u0435\u0440\u043d\u043e\u0435 \u0432\u0440\u0435\u043c\u044f \u0432\u0430\u043c \u0443\u0434\u043e\u0431\u043d\u043e \u043f\u0440\u0438\u043d\u044f\u0442\u044c \u0437\u0432\u043e\u043d\u043e\u043a.");
  }
  if (params.callbackPreferenceCaptured && preferredContactTime) {
    parts.splice(
      0,
      parts.length,
      `Спасибо, зафиксировал: ${preferredContactTime}. Менеджер свяжется с вами в это время.`,
    );
  }
  const phoneDeclined = nextInformationNeed === "PHONE_NUMBER" && params.lead.objections.some((objection) =>
    /телефон|номер/iu.test(objection) && /не хочу|не дам|не буду|отказыва|не готов|пока не/iu.test(objection));
  if (knowledge.unresolvedQuestions.length > 0) {
    const topics = knowledge.unresolvedQuestions
      .map((question) => question.replace(/[?\r\n]+/gu, " ").trim()).join("; ");
    const requiresContractContext = /договор|юридич|налог|страхов|оплат|рассроч|скидк/iu.test(topics);
    parts.push(requiresContractContext
      ? `Нюансы по вопросу «${topics}» лучше уточнить у менеджера; по остальным условиям я помогу сориентироваться.`
      : `По вопросу «${topics}» у меня нет подтверждённых деталей — эту часть лучше уточнить у менеджера.`);
  }

  if (decision.shouldHandoffToManager && !postHandoffContinuation) {
    parts.push(
      extraction.facts.phoneNumber && extraction.facts.phoneConfirmed
        ? "Спасибо, передал номер менеджеру. Подскажите, в какой день и примерно во сколько вам удобно принять звонок? Если пока не знаете, время можно согласовать уже с менеджером."
        : extraction.signals.wantsHuman || knowledge.unresolvedQuestions.length > 0 ||
        ["USER_REQUESTED_HUMAN", "UNKNOWN_BUSINESS_QUESTION"].includes(decision.reason)
        ? "Передам менеджеру контекст разговора, чтобы он мог продолжить с вами предметно."
        : "Основные данные собраны. Передам менеджеру краткий контекст, чтобы продолжить предметно.",
    );
  } else if (phoneDeclined) {
    parts.push("Понимаю, номер сейчас можно не оставлять. Можем продолжить общение здесь; для финальной передачи менеджеру он понадобится, когда вы будете готовы.");
  } else if (nextInformationNeed !== null) {
    parts.push(questionForInformationNeed(nextInformationNeed, params.lead));
  }

  if (parts.length === 0) {
    parts.push(currentTurnRequiresAnswer
      ? extraction.intent === "GREETING"
        ? "Я на связи и помогу разобраться с запуском бизнеса на посуточной аренде. Что Вы хотели бы узнать в первую очередь?"
        : "Хочу ответить по существу, но не уверен, к чему относится Ваш вопрос. Уточните, пожалуйста, что Вы имеете в виду?"
      : postHandoffContinuation ? "Понял, учту." : "Спасибо, понял.");
  }

  const prefix = extraction.intent === "GREETING" ? "Здравствуйте! " : "";
  return {
    text: `${prefix}${parts.join(" ")}`.trim(),
    nextInformationNeed,
    asksUserQuestion:
      !decision.shouldHandoffToManager && nextInformationNeed !== null && !phoneDeclined,
    knowledgeEntryIds: knowledgeEntryIdsForCurrentTurn,
    unresolvedQuestions: knowledge.unresolvedQuestions,
    useNaturalAdaptation: true,
    contextualReference: knowledge.contextualReferenceResolved,
    ...adaptiveContext,
    economicsContext: responseEconomics,
    approvedFacts: knowledge.approvedFacts,
  };
}

export function qualificationObjectiveForInformationNeed(
  need: InformationNeed,
): string {
  return qualificationObjectives[need];
}

export function questionForInformationNeed(
  need: InformationNeed,
  lead?: Lead,
): string {
  if (need === "PHONE_NUMBER" && lead && ["HOT", "PRIORITY", "QUALIFIED"].includes(lead.qualificationStatus)) {
    return "По основным параметрам вам подходит этот формат. Оставьте, пожалуйста, номер телефона, чтобы менеджер мог с вами связаться.";
  }
  if (
    need === "ADDITIONAL_EXPENSES" &&
    lead &&
    lead.availableCapital !== null &&
    lead?.capitalScope === "TOTAL_LIMIT"
  ) {
    return "Правильно понимаю, что названная сумма — общий предел на услугу команды, аренду, залог и комплектацию, или при необходимости сможете предусмотреть дополнительный бюджет?";
  }
  if (
    need === "ADDITIONAL_EXPENSES" &&
    lead &&
    lead.entryBudget !== null
  ) {
    return "Помимо первого этапа, для запуска понадобятся аренда, залог и базовая комплектация квартиры. Вы рассматриваете отдельный бюджет на эти расходы?";
  }
  return qualificationQuestions[need];
}
