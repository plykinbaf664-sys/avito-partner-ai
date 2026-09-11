import { createTelegramManagerUpdateProcessor } from "@/application/workflows/process-telegram-manager-update";
import { readTelegramEnvironment } from "@/config/environment";
import { SqlitePersistence } from "@/infrastructure/database/sqlite-persistence";
import { TelegramBotApiClient } from "@/integrations/telegram/telegram-bot-api-client";

import { createTelegramWebhookHandler } from "./route-handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  let persistence: SqlitePersistence | null = null;
  try {
    const telegram = readTelegramEnvironment(process.env);
    if (!telegram.enabled) {
      return Response.json({ error: "Not found" }, { status: 404 });
    }
    persistence = SqlitePersistence.create(telegram.databaseUrl);
    const sender = new TelegramBotApiClient(telegram.botToken!);
    const processUpdate = createTelegramManagerUpdateProcessor({
      persistence,
      sender,
      inviteCode: telegram.inviteCode!,
    });
    return await createTelegramWebhookHandler({
      enabled: true,
      secret: telegram.webhookSecret!,
      processUpdate,
    })(request);
  } catch {
    return Response.json({ error: "Temporarily unavailable" }, { status: 503 });
  } finally {
    persistence?.close();
  }
}
