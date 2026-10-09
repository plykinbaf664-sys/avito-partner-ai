import type { Persistence } from "../ports/repositories";

export type HealthComponent = "AVITO_POLLING" | "AVITO_MESSENGER" | "AVITO_OUTBOUND" | "APPLICATION_HTTP";
export interface HealthObservation {
  component: HealthComponent;
  state: "OK" | "DEGRADED" | "BLOCKED";
  errorCode: string | null;
  checkedAt: Date;
  lastSuccessAt: Date | null;
  consecutiveFailures: number;
}
export interface OperationalHealthRepository {
  observe(component: HealthComponent, state: HealthObservation["state"], code: string | null, at: Date): Promise<void>;
  list(): Promise<HealthObservation[]>;
  claimAlert(component: HealthComponent, fingerprint: string, at: Date, options?: { recovery?: boolean }): Promise<string | null>;
  finishAlert(component: HealthComponent, owner: string, fingerprint: string, sent: boolean, at: Date): Promise<void>;
  backlog(at: Date): Promise<{ pendingInbound: number; oldestPendingAt: number | null; failedInbound: number;
    failedOutbound: number; unresolvedOutbound: number; unverifiedInbound: number }>;
}
export interface OperationalStatus {
  ready: boolean;
  issues: string[];
  observations: HealthObservation[];
  backlog: Awaited<ReturnType<OperationalHealthRepository["backlog"]>>;
}
export const POLLING_STALE_MS = 5 * 60_000;
// A chat-specific 403 must not suspend unrelated conversations.
export const ACCESS_BLOCK_CODES = new Set(["AVITO_MESSENGER_ACCESS_PAYMENT_REQUIRED", "AVITO_INVALID_CREDENTIALS",
  "AVITO_UNAUTHORIZED"]);

export async function readOperationalStatus(persistence: Persistence, at: Date): Promise<OperationalStatus> {
  if (!persistence.operations) throw new Error("OPERATIONAL_HEALTH_UNAVAILABLE");
  const observations = await persistence.operations.list();
  const backlog = await persistence.operations.backlog(at);
  const issues: string[] = [];
  const polling = observations.find(row => row.component === "AVITO_POLLING");
  if (!polling || at.getTime() - polling.checkedAt.getTime() > POLLING_STALE_MS) issues.push("AVITO_POLLING_STALE");
  const messenger = observations.find(row => row.component === "AVITO_MESSENGER");
  if (!messenger) issues.push("AVITO_MESSENGER_UNVERIFIED");
  else if (at.getTime() - messenger.checkedAt.getTime() > POLLING_STALE_MS) issues.push("AVITO_MESSENGER_STALE");
  for (const row of observations) {
    if (row.state === "BLOCKED" || row.state === "DEGRADED" && row.consecutiveFailures >= 3) {
      issues.push(`${row.component}:${row.errorCode ?? "UNAVAILABLE"}`);
    }
  }
  if (backlog.oldestPendingAt !== null && at.getTime() - backlog.oldestPendingAt > 10 * 60_000) issues.push("INBOUND_BACKLOG_STALE");
  if (backlog.failedInbound > 0) issues.push("INBOUND_PROCESSING_FAILED");
  if (backlog.unresolvedOutbound > 0) issues.push("OUTBOUND_DELIVERY_FAILED");
  return { ready: issues.length === 0, issues: [...new Set(issues)], observations, backlog };
}

export function formatOperationalStatus(status: OperationalStatus): string {
  return [status.ready ? "✅ Автоответы: эксплуатационные проверки в норме" : "🚨 Автоответы: требуется внимание",
    ...status.issues.map(code => `• ${code}`),
    status.issues.some(code => code.includes("PAYMENT_REQUIRED"))
      ? "Avito вернул HTTP 402. Проверьте доступ к API мессенджера в подписке Avito; при активной опции обратитесь в поддержку Avito."
      : "",
    `Входящие в очереди: ${status.backlog.pendingInbound}; ошибки обработки: ${status.backlog.failedInbound}.`,
    status.backlog.unverifiedInbound ? `Ожидают загрузки настоящего содержимого из Avito: ${status.backlog.unverifiedInbound}.` : "",
    `Ошибки доставки за сутки: ${status.backlog.failedOutbound}; без последующего ответа команды: ${status.backlog.unresolvedOutbound}.`,
    "Проверка без отправки тестовых сообщений клиентам; доступ на запись подтверждается только реальной успешной доставкой.",
  ].filter(Boolean).join("\n");
}
