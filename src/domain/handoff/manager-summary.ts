import type { Lead } from "../lead/lead";
import { calculateEconomicsEstimate } from "../economics/economics-calculator";
import type { QualificationDecision } from "../qualification/qualification-policy";
import {
  assessFinancialReadiness,
  type FinancialBarrier,
  type FinancialReadiness,
  type LaunchCostAwareness,
} from "../qualification/financial-readiness";

export interface ManagerSummary {
  name: string | null;
  contact: string | null;
  city: string | null;
  budget: number | null;
  segment: Lead["segment"];
  segmentConfidence: number;
  availableCapital: number | null;
  entryBudget: number | null;
  additionalLaunchCapital: number | null;
  capitalScope: Lead["capitalScope"];
  additionalExpensesReadiness: Lead["additionalExpensesReadiness"];
  businessModelReadiness: Lead["businessModelReadiness"];
  launchCostAwareness: LaunchCostAwareness;
  financialReadiness: FinancialReadiness;
  financialBarrier: FinancialBarrier;
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
  economicsEstimateUnits: number | null;
  estimatedMonthlyPartnerIncome: number | null;
  incomeEstimateGuaranteed: false;
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
  const economicsEstimate = calculateEconomicsEstimate(
    lead.scalingPotentialUnits ?? lead.startingUnits,
  );
  const financialAssessment = assessFinancialReadiness(lead);
  const qualificationRationale =
    decision.status === "PRIORITY"
      ? "Подтверждены капитал, масштаб и готовность инвестора перейти к предметному обсуждению запуска."
      : decision.status === "HOT" || decision.status === "QUALIFIED"
        ? "Критические данные для выбранного сегмента собраны, готовность к запуску подтверждена."
        : decision.status === "WARM"
          ? "Критические данные собраны, но менеджеру нужно учесть слабые сигналы или проверить географию."
          : "Пользователь или содержание вопроса требует продолжения разговора с менеджером.";
  return {
    name: lead.name,
    contact: lead.contact,
    city: lead.city,
    budget: lead.budget,
    segment: lead.segment,
    segmentConfidence: lead.segmentConfidence,
    availableCapital: lead.availableCapital,
    entryBudget: lead.entryBudget,
    additionalLaunchCapital: lead.additionalLaunchCapital,
    capitalScope: lead.capitalScope,
    additionalExpensesReadiness: lead.additionalExpensesReadiness,
    businessModelReadiness: lead.businessModelReadiness,
    launchCostAwareness: financialAssessment.launchCostAwareness,
    financialReadiness: financialAssessment.financialReadiness,
    financialBarrier: financialAssessment.financialBarrier,
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
    economicsEstimateUnits: economicsEstimate?.units ?? null,
    estimatedMonthlyPartnerIncome:
      economicsEstimate?.estimatedMonthlyIncome ?? null,
    incomeEstimateGuaranteed: false,
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
