import type { Conversation } from "@/domain/conversation/conversation";
import type { DeliveryStatus } from "@/domain/delivery/delivery-state";
import type { ManagerSummary } from "@/domain/handoff/manager-summary";
import type { Lead } from "@/domain/lead/lead";
import type { FinancialReadiness } from "@/domain/qualification/financial-readiness";
import type { InformationNeed } from "@/domain/conversation/information-needs";

export const crmLeadFilters = [
  "all",
  "hot",
  "qualified",
  "handoff",
  "active",
  "no_fit",
] as const;

export type CrmLeadFilter = (typeof crmLeadFilters)[number];

export interface CrmLeadRecord {
  leadId: string;
  source: string;
  externalLeadId: string;
  conversationId: string | null;
  createdAt: Date;
  updatedAt: Date;
  lastActivityAt: Date;
  name: string | null;
  phoneNumber: string | null;
  segment: Lead["segment"];
  segmentConfidence: number;
  city: string | null;
  availableCapital: number | null;
  entryBudget: number | null;
  additionalLaunchCapital: number | null;
  startingUnits: number | null;
  scalingPotentialUnits: number | null;
  hasFreeTime: boolean | null;
  availableTimeDetails: string | null;
  goal: Lead["primaryGoal"];
  desiredIncome: number | null;
  launchTiming: Lead["launchTiming"];
  qualificationStatus: Lead["qualificationStatus"];
  qualificationReason: Lead["qualificationReason"];
  missingCriticalFacts: InformationNeed[];
  buyingIntent: string | null;
  financialReadiness: FinancialReadiness;
  shouldHandoffToManager: boolean;
  waitingForPhone: boolean;
  handoffAt: Date | null;
  handoffQualificationComplete: boolean;
  objections: string[];
  barriers: Array<NonNullable<Lead["primaryFear"]>>;
  managerSummary: ManagerSummary | null;
  managerNotificationStatus: DeliveryStatus | null;
  managerNotificationRetryable: boolean | null;
  managerNotificationErrorCode: string | null;
  conversationState: Conversation["state"] | null;
}

export interface CrmLeadDetails extends CrmLeadRecord {
  lead: Lead;
  messages: Array<{
    id: string;
    direction: "INBOUND" | "OUTBOUND";
    content: string;
    createdAt: Date;
    deliveryStatus: DeliveryStatus | null;
  }>;
}
