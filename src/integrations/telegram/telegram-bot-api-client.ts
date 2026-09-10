import { z } from "zod";

import type { ProviderDeliveryResult } from "@/application/ports/channels";

const telegramSuccessSchema = z.object({
  ok: z.literal(true),
  result: z.object({ message_id: z.number().int() }).passthrough(),
});

export interface TelegramTextSender {
  sendMessage(chatId: string, text: string): Promise<ProviderDeliveryResult>;
}

export class TelegramBotApiClient implements TelegramTextSender {
  constructor(
    private readonly botToken: string,
    private readonly timeoutMs = 10_000,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  async sendMessage(
    chatId: string,
    text: string,
  ): Promise<ProviderDeliveryResult> {
    let response: Response;
    try {
      response = await this.fetcher(
        `https://api.telegram.org/bot${this.botToken}/sendMessage`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ chat_id: chatId, text }),
          signal: AbortSignal.timeout(this.timeoutMs),
        },
      );
    } catch {
      return {
        status: "FAILED",
        retryable: true,
        errorCode: "TELEGRAM_NETWORK_ERROR",
      };
    }

    if (!response.ok) {
      return {
        status: "FAILED",
        retryable: response.status === 429 || response.status >= 500,
        errorCode: `TELEGRAM_HTTP_${response.status}`,
      };
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      return {
        status: "FAILED",
        retryable: false,
        errorCode: "TELEGRAM_INVALID_RESPONSE",
      };
    }
    const result = telegramSuccessSchema.safeParse(payload);
    return result.success
      ? { status: "SENT", externalId: String(result.data.result.message_id) }
      : {
          status: "FAILED",
          retryable: false,
          errorCode: "TELEGRAM_INVALID_RESPONSE",
        };
  }
}

