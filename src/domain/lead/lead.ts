import type {
  BusinessBarrier,
  LaunchTiming,
  ManagementReadiness,
  PrimaryGoal,
} from "../extraction/extracted-message";
import type { QualificationStatus } from "./qualification-status";
import type { ServiceabilityStatus } from "./serviceability";

export interface Lead {
  id: string;
  source: string;
  externalLeadId: string;
  name: string | null;
  contact: string | null;
  city: string | null;
  serviceability: ServiceabilityStatus;
  budget: number | null;
  budgetConfirmed: boolean;
  startingUnits: number | null;
  scalingPotentialUnits: number | null;
  hasFreeTime: boolean | null;
  availableTimeDetails: string | null;
  businessExperience: string | null;
  shortTermRentalExperience: string | null;
  ownsProperty: boolean | null;
  desiredIncome: number | null;
  primaryGoal: PrimaryGoal | null;
  primaryFear: BusinessBarrier | null;
  secondaryFear: BusinessBarrier | null;
  launchTiming: LaunchTiming | null;
  managementReadiness: ManagementReadiness | null;
  requiresGuaranteedIncome: boolean | null;
  rejectsBusinessModel: boolean | null;
  questions: string[];
  objections: string[];
  buyingIntent: string | null;
  qualificationStatus: QualificationStatus;
  qualificationReason: string | null;
  conversationSummary: string | null;
  createdAt: Date;
  updatedAt: Date;
  handoffAt: Date | null;
}

export type LeadFactPatch = Partial<
  Pick<
    Lead,
    | "name"
    | "contact"
    | "city"
    | "budget"
    | "budgetConfirmed"
    | "startingUnits"
    | "scalingPotentialUnits"
    | "hasFreeTime"
    | "availableTimeDetails"
    | "businessExperience"
    | "shortTermRentalExperience"
    | "ownsProperty"
    | "desiredIncome"
    | "primaryGoal"
    | "primaryFear"
    | "secondaryFear"
    | "launchTiming"
    | "managementReadiness"
    | "requiresGuaranteedIncome"
    | "rejectsBusinessModel"
    | "buyingIntent"
  >
>;
