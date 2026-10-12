import type { Persistence } from "../ports/repositories";
import type { TelegramTextSender } from "@/integrations/telegram/telegram-bot-api-client";
import { formatOperationalStatus, readOperationalStatus, HEALTHY_ALERT_FINGERPRINT, OUTAGE_ALERT_FINGERPRINT } from "./operational-health";
import type { ProviderDeliveryResult } from "../ports/channels";
import { createHash } from "node:crypto";

export async function runProductionWatchdog({ persistence, sender, now = new Date(), probeHttp }: {
  persistence: Persistence; sender?: TelegramTextSender; now?: Date; probeHttp: () => Promise<boolean>;
}) {
  const httpOk = await probeHttp().catch(() => false);
  await persistence.operations!.observe("APPLICATION_HTTP", httpOk ? "OK" : "BLOCKED", httpOk ? null : "APPLICATION_HTTP_UNAVAILABLE", now);
  const status = await readOperationalStatus(persistence, now);
  if (!sender) return { status, alerted: false, alertDelivery: "DISABLED" };
  // Readiness tolerates an isolated degraded observation. It is not evidence
  // of recovery: wait for fresh, actually successful component observations.
  if (status.ready && status.observations.some(row => row.state !== "OK")) {
    return { status, alerted: false, alertDelivery: "RECOVERY_PENDING" };
  }
  // Incident identity survives evolving symptoms and worker restarts. Report
  // only the outage transition and the confirmed recovery, never timed reminders.
  const fingerprint = status.ready ? HEALTHY_ALERT_FINGERPRINT : OUTAGE_ALERT_FINGERPRINT;
  const recipients = await persistence.telegramManagerRecipients.listActive();
  if (!recipients.length) return { status, alerted: false, alertDelivery: "NO_RECIPIENTS" };
  let delivered = 0;
  const deliveryErrors: Array<{ recipientRef: string; errorCode: string; retryable: boolean }> = [];
  for (const recipient of recipients) {
    const active = await persistence.telegramManagerRecipients.findByChatId(recipient.telegramChatId);
    if (!active?.isActive) continue;
    const owner = await persistence.operations!.claimRecipientAlert("APPLICATION_HTTP", recipient.id, fingerprint, now, { recovery: status.ready });
    if (!owner) continue;
    let result: ProviderDeliveryResult;
    try {
      result = await sender.sendMessage(recipient.telegramChatId,
        (status.ready ? "✅ Работа автоответов восстановлена\n\n" : "🚨 Сбой production avito-partner-ai\n\n") + formatOperationalStatus(status));
    } catch { result = { status: "FAILED", retryable: true, errorCode: "TELEGRAM_NETWORK_ERROR" }; }
    await persistence.operations!.finishRecipientAlert("APPLICATION_HTTP", recipient.id, owner, fingerprint, result, now);
    if (result.status === "SENT") delivered += 1;
    else {
      deliveryErrors.push({ recipientRef: createHash("sha256").update(recipient.id).digest("hex").slice(0,16),
        errorCode: /^[A-Z0-9_]{1,100}$/u.test(result.errorCode) ? result.errorCode : "TELEGRAM_DELIVERY_ERROR", retryable: result.retryable });
    }
  }
  return { status, alerted: delivered > 0, delivered, deliveryErrors,
    alertDelivery: deliveryErrors.length ? delivered ? "PARTIAL" : "FAILED" : delivered ? "SENT" : "THROTTLED" };
}
