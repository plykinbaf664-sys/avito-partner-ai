import { ZodError } from "zod";

import {
  verifyTelegramWebhookSecret,
  type TelegramManagerUpdateResult,
} from "@/application/workflows/process-telegram-manager-update";

const MAX_TELEGRAM_UPDATE_BYTES = 32 * 1024;

export function createTelegramWebhookHandler({
  enabled,
  secret,
  processUpdate,
}: {
  enabled: boolean;
  secret: string;
  processUpdate: (update: unknown) => Promise<TelegramManagerUpdateResult>;
}) {
  return async function handleTelegramWebhook(request: Request): Promise<Response> {
    if (!enabled) return Response.json({ error: "Not found" }, { status: 404 });
    if (
      !verifyTelegramWebhookSecret(
        request.headers.get("x-telegram-bot-api-secret-token"),
        secret,
      )
    ) {
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }

    const declaredLength = Number(request.headers.get("content-length") ?? "0");
    if (Number.isFinite(declaredLength) && declaredLength > MAX_TELEGRAM_UPDATE_BYTES) {
      return Response.json({ error: "Payload too large" }, { status: 413 });
    }

    try {
      const rawBody = await request.text();
      if (Buffer.byteLength(rawBody, "utf8") > MAX_TELEGRAM_UPDATE_BYTES) {
        return Response.json({ error: "Payload too large" }, { status: 413 });
      }
      const payload: unknown = JSON.parse(rawBody);
      await processUpdate(payload);
      return Response.json({ ok: true });
    } catch (error) {
      if (error instanceof SyntaxError || error instanceof ZodError) {
        return Response.json({ error: "Invalid update" }, { status: 400 });
      }
      return Response.json({ error: "Temporarily unavailable" }, { status: 503 });
    }
  };
}

