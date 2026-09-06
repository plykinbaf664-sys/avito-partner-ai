import type { Lead } from "../lead/lead";
import type { QualificationDecision } from "../qualification/qualification-policy";

export interface ManagerSummary {
  name: string | null;
  contact: string | null;
  city: string | null;
  budget: number | null;
  startingUnits: number | null;
  scalingPotentialUnits: number | null;
  launchTiming: Lead["launchTiming"];
  goal: Lead["primaryGoal"];
  businessExperience: string | null;
  shortTermRentalExperience: string | null;
  ownsProperty: boolean | null;
  managementReadiness: Lead["managementReadiness"];
  availableTime: string | null;
  desiredIncome: number | null;
  questions: string[];
  objections: string[];
  primaryBarrier: Lead["primaryFear"];
  secondaryBarrier: Lead["secondaryFear"];
  explainedKnowledge: string[];
  qualificationStatus: Lead["qualificationStatus"];
  reasonCodes: string[];
  qualificationRationale: string;
  buyingIntent: string | null;
  recommendedNextStep: string;
}

export function createManagerSummary(
  lead: Lead,
  decision: QualificationDecision,
  explainedKnowledge: string[],
): ManagerSummary {
  const qualificationRationale =
    decision.status === "PRIORITY"
      ? "Базовые требования подтверждены, заявлен потенциал запуска или масштабирования до 5+ объектов."
      : decision.status === "HOT" || decision.status === "QUALIFIED"
        ? "Критические данные собраны, бюджет и готовность к запуску подтверждены."
        : decision.status === "WARM"
          ? "Критические данные собраны, но менеджеру нужно учесть слабые сигналы или проверить географию."
          : "Пользователь или содержание вопроса требует продолжения разговора с менеджером.";
  return {
    name: lead.name,
    contact: lead.contact,
    city: lead.city,
    budget: lead.budget,
    startingUnits: lead.startingUnits,
    scalingPotentialUnits: lead.scalingPotentialUnits,
    launchTiming: lead.launchTiming,
    goal: lead.primaryGoal,
    businessExperience: lead.businessExperience,
    shortTermRentalExperience: lead.shortTermRentalExperience,
    ownsProperty: lead.ownsProperty,
    managementReadiness: lead.managementReadiness,
    availableTime: lead.availableTimeDetails,
    desiredIncome: lead.desiredIncome,
    questions: lead.questions,
    objections: lead.objections,
    primaryBarrier: lead.primaryFear,
    secondaryBarrier: lead.secondaryFear,
    explainedKnowledge,
    qualificationStatus: decision.status,
    reasonCodes: decision.reasonCodes,
    qualificationRationale,
    buyingIntent: lead.buyingIntent,
    recommendedNextStep:
      lead.serviceability === "NEEDS_REVIEW"
        ? "Проверить возможность работы в городе и связаться с лидом."
        : "Связаться с лидом и перейти к предметному обсуждению запуска.",
  };
}
