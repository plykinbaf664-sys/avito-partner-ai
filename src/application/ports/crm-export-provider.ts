import type { CrmLeadRecord } from "@/application/crm/crm-record";

export interface CrmExportProvider {
  upsertLead(record: CrmLeadRecord): Promise<void>;
}

// A future GoogleSheetsCrmProvider will implement this port and update rows by
// leadId. SQLite remains the source of truth; this port is not invoked yet.
export class NoopCrmExportProvider implements CrmExportProvider {
  async upsertLead(): Promise<void> {}
}
