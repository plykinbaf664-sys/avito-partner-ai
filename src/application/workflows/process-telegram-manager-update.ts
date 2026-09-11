import { createHash, timingSafeEqual } from "node:crypto";

import { z } from "zod";

import type { Persistence } from "../ports/repositories";
import type { TelegramTextSender } from "@/integrations/telegram/telegram-bot-api-client";
import { generateId, type IdGenerator } from "@/shared/id";

const telegramManagerUpdateSchema = z
  .object({
    update_id: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    message: z
      .object({
        text: z.string().trim().min(1).max(256),
        chat: z.object({
          id: z.number().int().safe(),
          type: z.string().max(32),
        }),
        from: z.object({
          id: z.number().int().safe(),
          username: z.string().max(64).optional(),
          first_name: z.string().max(128).optional(),
        }),
      })
      .optional(),
  })
  .passthrough();

export type TelegramManagerUpdateResult =
  | "REGISTERED"
  | "STOPPED"
  | "STATUS"
  | "INVITE_REQUESTED"
  | "INVALID_INVITE"
  | "IGNORED"
  | "DUPLICATE";

function secretMatches(actual: string, expected: string): boolean {
  const actualDigest = createHash("sha256").update(actual).digest();
  const expectedDigest = createHash("sha256").update(expected).digest();
  return timingSafeEqual(actualDigest, expectedDigest);
}

function commandOf(text: string): string | null {
  const first = text.split(/\s+/, 1)[0]?.toLowerCase() ?? "";
  const command = first.split("@", 1)[0];
  return command.startsWith("/") ? command : null;
}

export function createTelegramManagerUpdateProcessor({
  persistence,
  sender,
  inviteCode,
  now: clock = () => new Date(),
  generateId: idGenerator = generateId,
}: {
  persistence: Persistence;
  sender: TelegramTextSender;
  inviteCode: string;
  now?: () => Date;
  generateId?: IdGenerator;
}) {
  return async function processTelegramManagerUpdate(
    untrustedUpdate: unknown,
  ): Promise<TelegramManagerUpdateResult> {
    const update = telegramManagerUpdateSchema.parse(untrustedUpdate);
    const updateId = String(update.update_id);
    const claimed = await persistence.telegramBotUpdates.tryClaim(
      updateId,
      clock(),
    );
    if (!claimed) return "DUPLICATE";

    try {
      const message = update.message;
      if (!message || message.chat.type !== "private") return "IGNORED";

      const chatId = String(message.chat.id);
      const command = commandOf(message.text);
      const current =
        await persistence.telegramManagerRecipients.findByChatId(chatId);
      let result: TelegramManagerUpdateResult;
      let responseText: string;

      if (command === "/start") {
        result = "INVITE_REQUESTED";
        responseText = current?.isActive
          ? "Уведомления о горячих лидах уже включены."
          : "Введите код приглашения менеджера.";
      } else if (command === "/status") {
        result = "STATUS";
        responseText = current?.isActive
          ? "Уведомления о горячих лидах включены."
          : "Уведомления выключены. Для подключения отправьте /start и код приглашения.";
      } else if (command === "/stop") {
        await persistence.telegramManagerRecipients.deactivate(chatId, clock());
        result = "STOPPED";
        responseText = "Уведомления о горячих лидах выключены.";
      } else if (secretMatches(message.text, inviteCode)) {
        const timestamp = clock();
        await persistence.telegramManagerRecipients.upsertAuthorized({
          id: current?.id ?? idGenerator(),
          telegramChatId: chatId,
          telegramUserId: String(message.from.id),
          username: message.from.username ?? null,
          firstName: message.from.first_name ?? null,
          isActive: true,
          authorizedAt: timestamp,
          createdAt: current?.createdAt ?? timestamp,
          updatedAt: timestamp,
        });
        result = "REGISTERED";
        responseText = "Готово. Уведомления о горячих лидах включены.";
      } else {
        result = "INVALID_INVITE";
        responseText = "Неверный код приглашения. Менеджер не зарегистрирован.";
      }

      const delivery = await sender.sendMessage(chatId, responseText);
      if (delivery.status === "FAILED") {
        throw Object.assign(new Error("Telegram command response failed"), {
          retryable: delivery.retryable,
          code: delivery.errorCode,
        });
      }
      return result;
    } catch (error) {
      await persistence.telegramBotUpdates.release(updateId);
      throw error;
    }
  };
}

export function verifyTelegramWebhookSecret(
  supplied: string | null,
  expected: string,
): boolean {
  return supplied !== null && secretMatches(supplied, expected);
}
