import { z } from "zod";

const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
const secret = process.env.TELEGRAM_WEBHOOK_SECRET?.trim();
const webhookUrl = process.env.TELEGRAM_WEBHOOK_URL?.trim();

if (
  !token ||
  !secret || !/^[A-Za-z0-9_-]{16,128}$/.test(secret) ||
  !webhookUrl ||
  !z.string().url().safeParse(webhookUrl).success ||
  !webhookUrl.startsWith("https://")
) {
  console.error("TELEGRAM_WEBHOOK=FAIL reason=MISSING_OR_INVALID_CONFIGURATION");
  process.exitCode = 1;
} else {
  try {
    const response = await fetch(
      `https://api.telegram.org/bot${token}/setWebhook`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: webhookUrl, secret_token: secret }),
        signal: AbortSignal.timeout(10_000),
      },
    );
    const result = z.object({ ok: z.literal(true), result: z.literal(true) }).safeParse(await response.json());
    const configured = response.ok && result.success;
    console.log(
      configured
        ? "TELEGRAM_WEBHOOK=PASS configured=true"
        : `TELEGRAM_WEBHOOK=FAIL http=${response.status}`,
    );
    if (!configured) process.exitCode = 1;
  } catch {
    console.error("TELEGRAM_WEBHOOK=FAIL reason=NETWORK_ERROR");
    process.exitCode = 1;
  }
}
