import type {
  OutboundDeliveryRequest,
  OutboundMessageProvider,
  ProviderDeliveryResult,
} from "@/application/ports/channels";

import { AvitoApiClient, AvitoApiError } from "./avito-api-client";
import { silentLogger, type StructuredLogger } from "@/application/observability/structured-logger";

export class AvitoOutboundMessageProvider implements OutboundMessageProvider {
  constructor(private readonly client: AvitoApiClient, private readonly logger: StructuredLogger = silentLogger) {}

  async deliver(message: OutboundDeliveryRequest): Promise<ProviderDeliveryResult> {
    if (message.source.toUpperCase() !== "AVITO") {
      return {
        status: "FAILED",
        retryable: false,
        errorCode: "AVITO_SOURCE_MISMATCH",
      };
    }
    const started = performance.now();
    const fields = { source: "AVITO", conversationId: message.conversationId,
      chatId: message.externalRecipientId };
    try {
      const externalId = await this.client.sendTextMessage(
        message.externalRecipientId,
        message.text,
      );
      this.logger.info("avito.outbound.sent", { ...fields, providerMessageId: externalId,
        latencyMs: Math.round(performance.now() - started) });
      return { status: "SENT", externalId };
    } catch (error) {
      this.logger.error("avito.outbound.failed", { ...fields,
        errorCode: error instanceof AvitoApiError ? error.code : "AVITO_UNEXPECTED_ERROR",
        httpStatus: error instanceof AvitoApiError ? error.status : null,
        retryable: error instanceof AvitoApiError ? error.retryable : true,
        latencyMs: Math.round(performance.now() - started) });
      if (error instanceof AvitoApiError) {
        return {
          status: "FAILED",
          retryable: error.retryable,
          errorCode: error.code,
        };
      }
      return {
        status: "FAILED",
        retryable: true,
        errorCode: "AVITO_UNEXPECTED_ERROR",
      };
    }
  }
}
