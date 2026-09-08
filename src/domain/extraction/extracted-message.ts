export const messageIntents = [
  "GREETING",
  "GENERAL_INTEREST",
  "QUALIFICATION_INFORMATION",
  "QUESTION",
  "OBJECTION",
  "WANTS_HUMAN",
  "DECLINE",
  "UNKNOWN",
] as const;

export type MessageIntent = (typeof messageIntents)[number];

export const primaryGoals = [
  "ADDITIONAL_INCOME",
  "MAIN_BUSINESS",
  "LEAVE_EMPLOYMENT",
  "INVESTMENT",
  "SCALE_EXISTING_BUSINESS",
  "USE_OWN_PROPERTY",
  "RECOVER_PREVIOUS_FAILURE",
  "UNKNOWN",
] as const;

export type PrimaryGoal = (typeof primaryGoals)[number];

export const businessBarriers = [
  "FEAR_LOSE_MONEY",
  "FEAR_LOW_DEMAND",
  "FEAR_NO_PROPERTY",
  "FEAR_OPERATIONAL_LOAD",
  "FEAR_GUEST_PROBLEMS",
  "FEAR_LEGAL",
  "FEAR_NO_EXPERIENCE",
  "FEAR_DISTRUST_NUMBERS",
  "FEAR_PLATFORM_DEPENDENCY",
  "FEAR_PREVIOUS_FAILURE",
  "OTHER",
] as const;

export type BusinessBarrier = (typeof businessBarriers)[number];

export const launchTimings = [
  "READY_NOW",
  "WITHIN_MONTH",
  "WITHIN_THREE_MONTHS",
  "LATER",
  "NO_PLANS",
  "UNKNOWN",
] as const;

export type LaunchTiming = (typeof launchTimings)[number];

export const managementReadinessValues = [
  "READY",
  "LIMITED",
  "NOT_READY",
  "UNKNOWN",
] as const;

export type ManagementReadiness =
  (typeof managementReadinessValues)[number];

export const capitalScopes = [
  "ENTRY_ONLY",
  "TOTAL_LIMIT",
  "ADDITIONAL_AVAILABLE",
  "UNKNOWN",
] as const;
export type CapitalScope = (typeof capitalScopes)[number];

export const additionalExpensesReadinessValues = [
  "READY",
  "LIMITED",
  "NOT_READY",
  "UNKNOWN",
] as const;
export type AdditionalExpensesReadiness =
  (typeof additionalExpensesReadinessValues)[number];

export const businessModelReadinessValues = [
  "ACCEPTS",
  "CONSIDERING",
  "REJECTS",
  "UNKNOWN",
] as const;
export type BusinessModelReadiness =
  (typeof businessModelReadinessValues)[number];

export interface ExtractedFacts {
  city: string | null;
  budget: number | null;
  budgetConfirmed: boolean | null;
  availableCapital: number | null;
  availableCapitalConfirmed: boolean;
  entryBudget: number | null;
  additionalLaunchCapital: number | null;
  capitalScope: CapitalScope;
  additionalExpensesReadiness: AdditionalExpensesReadiness;
  businessModelReadiness: BusinessModelReadiness;
  calculationUnits: number | null;
  startingUnits: number | null;
  scalingPotentialUnits: number | null;
  hasFreeTime: boolean | null;
  availableTimeDetails: string | null;
  businessExperience: string | null;
  shortTermRentalExperience: string | null;
  ownsProperty: boolean | null;
  desiredIncome: number | null;
  primaryGoal: PrimaryGoal | null;
  launchTiming: LaunchTiming | null;
  managementReadiness: ManagementReadiness | null;
  requiresGuaranteedIncome: boolean | null;
  rejectsBusinessModel: boolean | null;
}

export interface ExtractedSignals {
  questions: string[];
  objections: string[];
  possiblePrimaryFear: BusinessBarrier | null;
  possibleSecondaryFear: BusinessBarrier | null;
  wantsHuman: boolean;
}

export interface ExtractedMessage {
  intent: MessageIntent;
  facts: ExtractedFacts;
  signals: ExtractedSignals;
  confidence: number | null;
  uncertainty: string[];
}
