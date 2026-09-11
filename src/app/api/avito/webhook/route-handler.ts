import { ZodError } from "zod";

import type { AcceptedIncomingEvent } from "@/application/workflows/accept-incoming-event";
import type { IncomingPartnerEvent } from "@/application/workflows/process-incoming-event";
import { AvitoApiError, type AvitoApiClient } from "@/integrations/avito/avito-api-client";
import { AvitoInboundChannel } from "@/integrations/avito/avito-inbound-channel";

const MAX_AVITO_WEBHOOK_BYTES = 32 * 1024;

async function readBoundedJson(request: Request): Promise<unknown> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_AVITO_WEBHOOK_BYTES) {
    throw new AvitoApiError("AVITO_WEBHOOK_TOO_LARGE", 413, false);
  }
  const raw = await request.text();
  if (Buffer.byteLength(raw, "utf8") > MAX_AVITO_WEBHOOK_BYTES) {
    throw new AvitoApiError("AVITO_WEBHOOK_TOO_LARGE", 413, false);
  }
  return JSON.parse(raw);
}

export function createAvitoWebhookHandler({
  enabled,
  client,
  channel = new AvitoInboundChannel(),
  accept,
  schedule,
}: {
  enabled: boolean;
  client: Pick<AvitoApiClient, "getAuthenticatedAccount" | "getInboundMessage">;
  channel?: AvitoInboundChannel;
  accept: (input: IncomingPartnerEvent) => Promise<AcceptedIncomingEvent>;
  schedule: (input: IncomingPartnerEvent) => void;
}) {
  return async function handleAvitoWebhook(request: Request): Promise<Response> {
    if (!enabled) return Response.json({ error: "Not found" }, { status: 404 });
    if (!(request.headers.get("content-type") ?? "").includes("application/json")) {
      return Response.json({ error: "Unsupported media type" }, { status: 415 });
    }
    try {
      const normalized = await channel.normalize(await readBoundedJson(request));
      const account = await client.getAuthenticatedAccount();
      if (normalized.accountId !== account.id) {
        return Response.json({ error: "Unauthorized event" }, { status: 401 });
      }

      // Avito's Messenger webhook schema does not provide an application
      // signature. Cross-check the message with the authenticated API before
      // any paid LLM work; idempotency alone is not authentication.
      const verified = await client.getInboundMessage(
        normalized.externalLeadId,
        normalized.messageId,
      );
      if (verified.authorId !== normalized.authorId || verified.text !== normalized.message) {
        return Response.json({ error: "Unauthorized event" }, { status: 401 });
      }
      if (verified.type !== "text" || !verified.text) {
        return Response.json({ ok: true, ignored: true });
      }

      const accepted = await accept(
        channel.fromVerifiedMessage(normalized.externalLeadId, verified),
      );
      if (accepted.shouldProcess) schedule(accepted.input);
      return Response.json({ ok: true, duplicate: !accepted.created });
    } catch (error) {
      if (error instanceof SyntaxError || error instanceof ZodError) {
        return Response.json({ error: "Invalid Avito update" }, { status: 400 });
      }
      if (error instanceof AvitoApiError) {
        if (error.code === "AVITO_WEBHOOK_TOO_LARGE") {
          return Response.json({ error: "Payload too large" }, { status: 413 });
        }
        return Response.json(
          { error: "Avito verification unavailable" },
          { status: error.retryable ? 503 : 401 },
        );
      }
      return Response.json({ error: "Temporarily unavailable" }, { status: 503 });
    }
  };
}

