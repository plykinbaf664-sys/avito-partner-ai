import assert from "node:assert/strict";
import { readTelegramEnvironment } from "../src/config/environment";
import { SqlitePersistence } from "../src/infrastructure/database/sqlite-persistence";
import { createTelegramManagerUpdateProcessor } from "../src/application/workflows/process-telegram-manager-update";
import { createTelegramWebhookHandler } from "../src/app/api/telegram/webhook/route-handler";
import type { Persistence } from "../src/application/ports/repositories";

// Read production aggregates, exercise the real command/webhook handler with
// an in-memory update ledger and recording sender. No DB writes or Telegram
// messages, and no LLM calls. Never print identities or secret-bearing errors.
async function main() {
  const config = readTelegramEnvironment(process.env);
  if (!config.enabled || !config.webhookSecret) throw new Error("TELEGRAM_NOT_CONFIGURED");
  const persistence = SqlitePersistence.create(config.databaseUrl);
  try {
    await persistence.checkReadiness();
    const asOf = new Date();
    const snapshot = await persistence.botStatus.snapshot(asOf);
    const recipients = await persistence.telegramManagerRecipients.listActive();
    assert(recipients.length > 0, "No active manager to verify status authorization");
    const recipient = recipients.find((item) => item.telegramChatId === item.telegramUserId)!;
    assert(recipient, "No private manager identity");
    const identity = Number(recipient.telegramChatId);
    assert(Number.isSafeInteger(identity));
    const updateIds = new Set<string>();
    const readOnlyRuntime = new Proxy(persistence, {
      get(target, property) {
        if (property === "telegramBotUpdates") return {
          async tryClaim(id: string) {
            if (updateIds.has(id)) return false;
            updateIds.add(id); return true;
          },
          async release(id: string) { updateIds.delete(id); },
        };
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as Persistence;
    const messages: string[] = [];
    const processor = createTelegramManagerUpdateProcessor({ persistence: readOnlyRuntime,
      sender: { async sendMessage(_chatId, text) {
        messages.push(text); return { status: "SENT", externalId: "recorded-only" };
      } }, inviteCode: config.inviteCode!, now: () => asOf });
    const handler = createTelegramWebhookHandler({ enabled: true,
      secret: config.webhookSecret, processUpdate: processor });
    const request = (id: number, from = identity, secret = config.webhookSecret!) => new Request(
      "http://localhost/api/telegram/webhook", { method: "POST",
        headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": secret },
        body: JSON.stringify({ update_id: id, message: { text: "/status", chat: { id: identity, type: "private" },
          from: { id: from } } }),
      });
    assert.equal((await handler(request(1))).status, 200);
    assert.equal(messages.length, 1);
    assert(messages[0].includes("Статистика Avito"));
    assert(messages[0].length < 4096);
    assert.equal((await handler(request(1))).status, 200);
    assert.equal(messages.length, 1, "Duplicate must not send again");
    assert.equal((await handler(request(2, identity + 1))).status, 200);
    assert(!messages[1].includes("Статистика Avito"), "Sender mismatch must not expose analytics");
    assert.equal((await handler(request(3, identity, "wrong-secret"))).status, 401);
    assert.equal(messages.length, 2);
    console.log(JSON.stringify({ event: "telegram_status.smoke", status: "PASS",
      sentToTelegram: false, databaseWrites: false, llmCalls: 0, activeManagers: recipients.length,
      ...snapshot }));
  } finally { persistence.close(); }
}

main().catch(() => {
  console.error("TELEGRAM_STATUS_SMOKE=FAIL");
  process.exitCode = 1;
});
