import type { InformationNeed } from "./information-needs";
import type { ExtractedMessage } from "../extraction/extracted-message";
import type { Lead } from "../lead/lead";
import type {
  QualificationDecision,
  QualificationReasonCode,
} from "../qualification/qualification-policy";
import type { KnowledgeAnswer } from "../knowledge/knowledge-base";

const qualificationQuestions: Record<InformationNeed, string> = {
  AVAILABLE_CAPITAL:
    "Какую сумму вы реально готовы выделить на проект: это бюджет только на первый этап или общий доступный капитал?",
  ADDITIONAL_EXPENSES:
    "Готовы ли вы отдельно учитывать расходы по самому объекту — например залог, оснащение и обслуживание? Точную сумму сейчас называть не нужно.",
  BUSINESS_MODEL:
    "Рассматриваете именно запуск бизнеса через субаренду с помощью управляющей компании?",
  LAUNCH_TIMING: "Когда примерно вы рассматриваете запуск?",
  CITY: "В каком городе вы планируете запускать объекты?",
  STARTING_UNITS: "Со скольких объектов хотите начать?",
  SCALING_POTENTIAL_UNITS: "До какого количества объектов в перспективе готовы масштабироваться?",
  GOAL: "Какую главную цель хотите решить этим бизнесом?",
  MANAGEMENT_READINESS:
    "Готовы взаимодействовать с управляющей компанией и участвовать в ключевых решениях по запуску?",
  FREE_TIME: "Сколько времени вы сможете уделять проекту?",
  EXPERIENCE: "Есть ли у вас опыт в бизнесе или посуточной аренде?",
  BARRIER: "Что сейчас больше всего останавливает или вызывает сомнения?",
};

const rejectionMessages: Partial<Record<QualificationReasonCode, string>> = {
  NO_LAUNCH_INTENT:
    "Понял. Раз запуск вы сейчас не рассматриваете, не буду продолжать квалификацию. Если планы изменятся, можно вернуться к разговору.",
  NO_MANAGEMENT_INTERACTION:
    "Понял. В этой модели всё же нужно взаимодействовать с управляющей компанией по ключевым вопросам, поэтому сейчас формат вам не подойдёт.",
  DECLINED_BY_LEAD:
    "Понял, спасибо за прямой ответ. Не буду больше отвлекать. Если интерес вернётся, можно продолжить разговор.",
  REQUIRES_INCOME_GUARANTEE:
    "Компания не гарантирует доход или прибыль. Если гарантия является обязательным условием, текущий формат вам не подойдёт.",
  INCOMPATIBLE_BUSINESS_MODEL:
    "Понял. Судя по вашему условию, текущая модель бизнеса вам не подходит, поэтому не буду продолжать квалификацию.",
  UNWILLING_TO_FUND_REQUIRED_EXPENSES:
    "Помимо услуги команды, для запуска нужно самостоятельно оплатить аренду, залог и базовую комплектацию объекта. Вы указали, что не готовы финансировать эти обязательные расходы, поэтому в текущем формате запуск не получится.",
};

export interface ConversationResponsePlan {
  text: string;
  nextInformationNeed: InformationNeed | null;
  asksUserQuestion: boolean;
  knowledgeEntryIds: string[];
  unresolvedQuestions: string[];
  useNaturalAdaptation: boolean;
}

export function buildConversationResponse(params: {
  lead: Lead;
  extraction: ExtractedMessage;
  decision: QualificationDecision;
  nextInformationNeed: InformationNeed | null;
  knowledge: KnowledgeAnswer;
}): ConversationResponsePlan {
  const { extraction, decision, nextInformationNeed, knowledge } = params;

  if (decision.nextAction === "REJECT_POLITELY") {
    return {
      text:
        rejectionMessages[decision.reason] ??
        "К сожалению, текущий формат вам не подойдёт. Спасибо за разговор.",
      nextInformationNeed: null,
      asksUserQuestion: false,
      knowledgeEntryIds: knowledge.entryIds,
      unresolvedQuestions: [],
      useNaturalAdaptation: false,
    };
  }

  const parts = [...knowledge.answerFragments];
  if (knowledge.unresolvedQuestions.length > 0) {
    parts.push("Этот момент лучше уточнить у менеджера.");
  }

  if (decision.shouldHandoffToManager) {
    parts.push(
      extraction.signals.wantsHuman || knowledge.unresolvedQuestions.length > 0
        ? "Передам менеджеру контекст разговора, чтобы он мог продолжить с вами предметно."
        : "Основные данные собраны. Передам менеджеру краткий контекст, чтобы продолжить предметно.",
    );
  } else if (nextInformationNeed !== null) {
    parts.push(questionForInformationNeed(nextInformationNeed, params.lead));
  }

  if (parts.length === 0) {
    parts.push("Спасибо, понял.");
  }

  const prefix = extraction.intent === "GREETING" ? "Здравствуйте! " : "";
  return {
    text: `${prefix}${parts.join(" ")}`.trim(),
    nextInformationNeed,
    asksUserQuestion:
      !decision.shouldHandoffToManager && nextInformationNeed !== null,
    knowledgeEntryIds: knowledge.entryIds,
    unresolvedQuestions: knowledge.unresolvedQuestions,
    useNaturalAdaptation:
      parts.length >= 3 ||
      extraction.signals.questions.length + extraction.signals.objections.length > 1,
  };
}

export function questionForInformationNeed(
  need: InformationNeed,
  lead?: Lead,
): string {
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
