export interface TelegramManagerRecipient {
  id: string;
  telegramChatId: string;
  telegramUserId: string;
  username: string | null;
  firstName: string | null;
  isActive: boolean;
  authorizedAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

