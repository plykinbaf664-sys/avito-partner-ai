import { describe, expect, it, vi } from "vitest";

import { TelegramBotApiClient } from "./telegram-bot-api-client";

describe("Telegram Bot API client", () => {
  it("returns the external message id and uses plain text", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ ok: true, result: { message_id: 321 } }), {
        status: 200,
      }),
    );
    const client = new TelegramBotApiClient("secret-token", 10_000, fetcher);
    await expect(client.sendMessage("101", "hello <world>")).resolves.toEqual({
      status: "SENT",
      externalId: "321",
    });
    const body = JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body));
    expect(body).toEqual({ chat_id: "101", text: "hello <world>" });
    expect(body).not.toHaveProperty("parse_mode");
  });

  it.each([
    [429, true],
    [503, true],
    [401, false],
    [400, false],
  ])("classifies HTTP %s", async (status, retryable) => {
    const client = new TelegramBotApiClient(
      "secret-token",
      10_000,
      vi.fn<typeof fetch>().mockResolvedValue(new Response("", { status })),
    );
    await expect(client.sendMessage("1", "test")).resolves.toEqual({
      status: "FAILED",
      retryable,
      errorCode: `TELEGRAM_HTTP_${status}`,
    });
  });
});

