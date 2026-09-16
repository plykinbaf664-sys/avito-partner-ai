import type { Lead } from "./lead";

export const leadSegments = [
  "SMALL_BUSINESS",
  "INVESTOR",
  "UNDETERMINED",
] as const;

export type LeadSegment = (typeof leadSegments)[number];

export interface LeadSegmentAssessment {
  segment: LeadSegment;
  confidence: number;
}

export const SEGMENTATION_REFERENCE = Object.freeze({
  smallBusinessEntryCapital: 50_000,
  smallBusinessTargetMinUnits: 3,
  smallBusinessTargetMaxUnits: 5,
  investorCapital: 1_500_000,
});

export function assessLeadSegment(
  lead: Pick<
    Lead,
    | "availableCapital"
    | "entryBudget"
    | "startingUnits"
    | "scalingPotentialUnits"
    | "primaryGoal"
    | "businessModelReadiness"
  > & Partial<Pick<Lead, "buyingIntent" | "questions">>,
): LeadSegmentAssessment {
  let investorScore = 0;
  let smallBusinessScore = 0;
  const capital = lead.availableCapital ?? lead.entryBudget;

  if (
    lead.availableCapital !== null &&
    lead.availableCapital >= SEGMENTATION_REFERENCE.investorCapital
  ) {
    investorScore += 3;
  }
  if (lead.primaryGoal === "INVESTMENT") investorScore += 2;
  if (
    lead.primaryGoal === "INVESTMENT" &&
    ((lead.startingUnits ?? 0) > SEGMENTATION_REFERENCE.smallBusinessTargetMaxUnits ||
      (lead.scalingPotentialUnits ?? 0) > SEGMENTATION_REFERENCE.smallBusinessTargetMaxUnits)
  ) {
    investorScore += 2;
  }

  if (
    lead.startingUnits !== null &&
    lead.startingUnits >= 1 &&
    lead.startingUnits <= SEGMENTATION_REFERENCE.smallBusinessTargetMaxUnits
  ) {
    smallBusinessScore += 3;
  }
  if (
    lead.scalingPotentialUnits !== null &&
    lead.scalingPotentialUnits >= SEGMENTATION_REFERENCE.smallBusinessTargetMinUnits &&
    lead.scalingPotentialUnits <= SEGMENTATION_REFERENCE.smallBusinessTargetMaxUnits
  ) {
    smallBusinessScore += 2;
  }
  if (
    capital !== null &&
    capital >= SEGMENTATION_REFERENCE.smallBusinessEntryCapital &&
    capital < SEGMENTATION_REFERENCE.investorCapital
  ) {
    smallBusinessScore += 2;
  }
  if (
    lead.businessModelReadiness === "ACCEPTS" ||
    lead.businessModelReadiness === "CONSIDERING"
  ) {
    smallBusinessScore += 1;
  }
  if (
    lead.primaryGoal !== null &&
    lead.primaryGoal !== "UNKNOWN" &&
    lead.primaryGoal !== "INVESTMENT"
  ) {
    smallBusinessScore += 1;
  }
  if (lead.buyingIntent === "GENERAL_INTEREST" ||
      lead.questions?.some((question) => /бизнес|субаренд|запуск|начать/iu.test(question))) {
    smallBusinessScore += 1;
  }

  if (investorScore >= 4 && investorScore > smallBusinessScore) {
    return {
      segment: "INVESTOR",
      confidence: investorScore >= 6 ? 0.95 : 0.75,
    };
  }
  if (smallBusinessScore >= 3 && smallBusinessScore >= investorScore) {
    return {
      segment: "SMALL_BUSINESS",
      confidence: smallBusinessScore >= 5 ? 0.95 : 0.75,
    };
  }
  return {
    segment: "UNDETERMINED",
    confidence: Math.max(investorScore, smallBusinessScore) >= 2 ? 0.4 : 0.15,
  };
}
