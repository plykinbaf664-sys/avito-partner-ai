import { describe, expect, it, vi } from "vitest";

import { createTelegramWebhookHandler } from "./route-handler";

const secret = "strong_invite_code_123";

function telegramRequest(body: string, suppliedSecret: string | null = secret) {
  const headers = new Headers({ "Content-Type": "application/json" });
  if (suppliedSecret) {
    headers.set("X-Telegram-Bot-Api-Secret-Token", suppliedSecret);
  }
  return new Request("http://localhost/api/telegram/webhook", {
    method: "POST",
    headers,
    body,
  });
}

describe("Telegram webhook route boundary", () => {
  it("fails closed when disabled or unauthenticated", async () => {
    const processUpdate = vi.fn().mockResolvedValue("IGNORED");
    const disabled = createTelegramWebhookHandler({
      enabled: false,
      secret,
      processUpdate,
    });
    expect((await disabled(telegramRequest("{}"))).status).toBe(404);

    const enabled = createTelegramWebhookHandler({
      enabled: true,
      secret,
      processUpdate,
    });
    const response = await enabled(telegramRequest("{}", "wrong-secret"));
    expect(response.status).toBe(401);
    expect(processUpdate).not.toHaveBeenCalled();
  });

  it("rejects malformed and oversized input", async () => {
    const processUpdate = vi.fn().mockResolvedValue("IGNORED");
    const handler = createTelegramWebhookHandler({
      enabled: true,
      secret,
      processUpdate,
    });
    expect((await handler(telegramRequest("{"))).status).toBe(400);
    expect((await handler(telegramRequest("x".repeat(33 * 1024)))).status).toBe(
      413,
    );
  });

  it("accepts a valid authenticated Telegram update", async () => {
    const processUpdate = vi.fn().mockResolvedValue("REGISTERED");
    const handler = createTelegramWebhookHandler({
      enabled: true,
      secret,
      processUpdate,
    });
    const payload = { update_id: 1, message: { text: "/start" } };
    const response = await handler(telegramRequest(JSON.stringify(payload)));
    expect(response.status).toBe(200);
    expect(processUpdate).toHaveBeenCalledWith(payload);
  });
});

