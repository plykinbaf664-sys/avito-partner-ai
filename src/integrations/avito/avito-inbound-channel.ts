import { z } from "zod";

import type { InboundChannel, InboundChannelEvent } from "@/application/ports/channels";
import type { IncomingPartnerEvent } from "@/application/workflows/process-incoming-event";

import type { AvitoMessage } from "./avito-api-client";

const idSchema = z.union([
  z.string().min(1).max(255),
  z.number().int().nonnegative(),
]);

const avitoWebhookSchema = z.object({
  id: idSchema,
  payload: z.object({
    type: z.literal("message"),
    value: z.object({
      author_id: idSchema,
      chat_id: idSchema,
      content: z.object({ text: z.string().trim().min(1).max(10_000) }).passthrough(),
      created: z.number().int().nonnegative(),
      id: idSchema,
      published_at: z.number().int().nonnegative().optional(),
      type: z.string().min(1).max(64),
      user_id: idSchema,
    }).passthrough(),
  }).passthrough(),
  timestamp: z.number().int().nonnegative().optional(),
  version: z.string().max(32).optional(),
}).passthrough();

export interface NormalizedAvitoWebhook extends InboundChannelEvent {
  accountId: string;
  authorId: string;
  messageId: string;
  receivedAt: Date;
}

function fromUnixSeconds(value: number): Date {
  const date = new Date(value * 1_000);
  if (!Number.isFinite(date.getTime())) throw new Error("Invalid Avito timestamp");
  return date;
}

export class AvitoInboundChannel implements InboundChannel {
  async normalize(untrustedPayload: unknown): Promise<NormalizedAvitoWebhook> {
    const parsed = avitoWebhookSchema.parse(untrustedPayload);
    const value = parsed.payload.value;
    return {
      source: "AVITO",
      externalEventId: String(value.id),
      externalLeadId: String(value.chat_id),
      messageId: String(value.id),
      message: value.content.text,
      receivedAt: fromUnixSeconds(value.published_at ?? value.created),
      accountId: String(value.user_id),
      authorId: String(value.author_id),
      rawPayload: {
        webhookEventId: String(parsed.id),
        messageType: value.type,
      },
    };
  }

  fromVerifiedMessage(chatId: string, message: AvitoMessage): IncomingPartnerEvent {
    if (message.direction !== "in" || message.type !== "text" || !message.text) {
      throw new Error("Unsupported Avito message");
    }
    return {
      source: "AVITO",
      externalEventId: message.id,
      externalLeadId: chatId,
      messageId: message.id,
      text: message.text,
      receivedAt: fromUnixSeconds(message.createdAtUnix),
      rawPayload: { messageType: message.type },
    };
  }
}

