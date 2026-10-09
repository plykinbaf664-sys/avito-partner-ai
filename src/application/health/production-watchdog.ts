import { createHash } from "node:crypto";
import type { Persistence } from "../ports/repositories";
import type { TelegramTextSender } from "@/integrations/telegram/telegram-bot-api-client";
import { formatOperationalStatus, readOperationalStatus } from "./operational-health";

export async function runProductionWatchdog({ persistence, sender, now = new Date(), probeHttp }: {
  persistence: Persistence; sender?: TelegramTextSender; now?: Date; probeHttp: () => Promise<boolean>;
}) {
  const httpOk = await probeHttp().catch(() => false);
  await persistence.operations!.observe("APPLICATION_HTTP", httpOk ? "OK" : "BLOCKED", httpOk ? null : "APPLICATION_HTTP_UNAVAILABLE", now);
  const status = await readOperationalStatus(persistence, now);
  if (!sender) return { status, alerted: false, alertDelivery: "DISABLED" };
  const fingerprint = createHash("sha256").update(JSON.stringify(status.issues.slice().sort())).digest("hex");
  const recipients = await persistence.telegramManagerRecipients.listActive();
  if (!recipients.length) return { status, alerted: false, alertDelivery: "NO_RECIPIENTS" };
  const owner = await persistence.operations!.claimAlert("APPLICATION_HTTP", fingerprint, now, { recovery: status.ready });
  if (!owner) return { status, alerted: false, alertDelivery: "THROTTLED" };
  let sent = true;
  try {
    for (const recipient of recipients) {
      const active = await persistence.telegramManagerRecipients.findByChatId(recipient.telegramChatId);
      if (!active?.isActive) continue;
      const result = await sender.sendMessage(recipient.telegramChatId,
        (status.ready ? "✅ Работа автоответов восстановлена\n\n" : "🚨 Сбой production avito-partner-ai\n\n") + formatOperationalStatus(status));
      if (result.status !== "SENT") sent = false;
    }
  } catch { sent = false; }
  await persistence.operations!.finishAlert("APPLICATION_HTTP", owner, fingerprint, sent, now);
  return { status, alerted: sent, alertDelivery: sent ? "SENT" : "FAILED" };
}
