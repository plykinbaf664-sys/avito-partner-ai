import type {
  CrmLeadSnapshot,
  Persistence,
} from "@/application/ports/repositories";
import { assessFinancialReadiness } from "@/domain/qualification/financial-readiness";
import { normalizePhoneNumber } from "@/domain/lead/phone-number";
import type {
  CrmLeadDetails,
  CrmLeadFilter,
  CrmLeadRecord,
} from "./crm-record";

export const CRM_PAGE_SIZE = 50;
export const CRM_MAX_SEARCH_LENGTH = 100;
export const CRM_EXPORT_BATCH_SIZE = 500;
export const CRM_MAX_PAGE = 1_000_000;

function toRecord(snapshot: CrmLeadSnapshot): CrmLeadRecord {
  const { lead, conversation, managerNotification } = snapshot;
  const financial = assessFinancialReadiness(lead);
  return {
    leadId: lead.id,
    source: lead.source,
    externalLeadId: lead.externalLeadId,
    conversationId: conversation?.id ?? null,
    createdAt: lead.createdAt,
    updatedAt: lead.updatedAt,
    lastActivityAt: snapshot.lastActivityAt,
    name: lead.name,
    phoneNumber: lead.phoneNumber,
    segment: lead.segment,
    segmentConfidence: lead.segmentConfidence,
    city: lead.city,
    availableCapital: lead.availableCapital,
    entryBudget: lead.entryBudget,
    additionalLaunchCapital: lead.additionalLaunchCapital,
    startingUnits: lead.startingUnits,
    scalingPotentialUnits: lead.scalingPotentialUnits,
    goal: lead.primaryGoal,
    launchTiming: lead.launchTiming,
    qualificationStatus: lead.qualificationStatus,
    buyingIntent: lead.buyingIntent,
    financialReadiness: financial.financialReadiness,
    shouldHandoffToManager: lead.handoffAt !== null,
    handoffAt: lead.handoffAt,
    objections: lead.objections,
    barriers: [lead.primaryFear, lead.secondaryFear].filter(
      (value): value is NonNullable<typeof value> => value !== null,
    ),
    managerSummary: managerNotification?.summary ?? null,
    managerNotificationStatus: managerNotification?.deliveryStatus ?? null,
    managerNotificationRetryable:
      managerNotification?.deliveryRetryable ?? null,
    managerNotificationErrorCode:
      managerNotification?.lastDeliveryErrorCode ?? null,
    conversationState: conversation?.state ?? null,
  };
}

export interface ListCrmLeadsInput {
  filter?: CrmLeadFilter;
  search?: string | null;
  page?: number;
}

export function createCrmService(persistence: Persistence) {
  return {
    async listLeads(input: ListCrmLeadsInput = {}) {
      const filter = input.filter ?? "all";
      const rawSearch =
        input.search?.trim().slice(0, CRM_MAX_SEARCH_LENGTH) || null;
      const search = rawSearch
        ? normalizePhoneNumber(rawSearch) ?? rawSearch
        : null;
      const requestedPage = input.page ?? 1;
      const page =
        Number.isSafeInteger(requestedPage) && requestedPage > 0
          ? Math.min(requestedPage, CRM_MAX_PAGE)
          : 1;
      const query = {
        filter,
        search,
        limit: CRM_PAGE_SIZE,
        offset: (page - 1) * CRM_PAGE_SIZE,
      };
      const [snapshots, total] = await Promise.all([
        persistence.crm.listLeadSnapshots(query),
        persistence.crm.countLeadSnapshots(query),
      ]);
      return {
        records: snapshots.map(toRecord),
        page,
        pageSize: CRM_PAGE_SIZE,
        total,
        totalPages: Math.max(1, Math.ceil(total / CRM_PAGE_SIZE)),
      };
    },

    async getLead(leadId: string): Promise<CrmLeadDetails | null> {
      const snapshot = await persistence.crm.findLeadSnapshot(leadId);
      if (!snapshot) return null;
      const messages = snapshot.conversation
        ? await persistence.messages.listRecentByConversationId(
            snapshot.conversation.id,
            100,
          )
        : [];
      return {
        ...toRecord(snapshot),
        lead: snapshot.lead,
        messages: messages.map((message) => ({
          id: message.id,
          direction: message.direction,
          content: message.content,
          createdAt: message.createdAt,
          deliveryStatus: message.deliveryStatus,
        })),
      };
    },

    async exportLeads(): Promise<CrmLeadRecord[]> {
      const total = await persistence.crm.countLeadSnapshots({
        filter: "all",
        search: null,
      });
      const records: CrmLeadRecord[] = [];
      for (let offset = 0; offset < total; offset += CRM_EXPORT_BATCH_SIZE) {
        const snapshots = await persistence.crm.listLeadSnapshots({
          filter: "all",
          search: null,
          limit: CRM_EXPORT_BATCH_SIZE,
          offset,
        });
        records.push(...snapshots.map(toRecord));
      }
      return records;
    },
  };
}
