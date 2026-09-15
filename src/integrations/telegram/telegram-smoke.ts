import type { Persistence } from "@/application/ports/repositories";
import type { TelegramTextSender } from "./telegram-bot-api-client";

export async function sendTelegramSmokeNotification(
  persistence: Pick<Persistence, "telegramManagerRecipients">,
  sender: TelegramTextSender,
  chatId: string,
) {
  if (!/^[1-9]\d*$/.test(chatId) || !Number.isSafeInteger(Number(chatId))) {
    throw new Error("TELEGRAM_SMOKE_INVALID_CHAT_ID");
  }
  const recipient = await persistence.telegramManagerRecipients.findByChatId(chatId);
  if (!recipient?.isActive || recipient.telegramUserId !== chatId) {
    throw new Error("TELEGRAM_SMOKE_REGISTERED_TEST_MANAGER_REQUIRED");
  }
  // No Lead or production notification is created and there is no broadcast.
  return sender.sendMessage(chatId,
    "🧪 Тест уведомлений менеджера\nTelegram-доставка работает. Это технический тест, лид не создавался.");
}
