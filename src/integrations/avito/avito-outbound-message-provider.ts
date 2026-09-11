import type {
  OutboundDeliveryRequest,
  OutboundMessageProvider,
  ProviderDeliveryResult,
} from "@/application/ports/channels";

import { AvitoApiClient, AvitoApiError } from "./avito-api-client";

export class AvitoOutboundMessageProvider implements OutboundMessageProvider {
  constructor(private readonly client: AvitoApiClient) {}

  async deliver(message: OutboundDeliveryRequest): Promise<ProviderDeliveryResult> {
    if (message.source.toUpperCase() !== "AVITO") {
      return {
        status: "FAILED",
        retryable: false,
        errorCode: "AVITO_SOURCE_MISMATCH",
      };
    }
    try {
      const externalId = await this.client.sendTextMessage(
        message.externalRecipientId,
        message.text,
      );
      return { status: "SENT", externalId };
    } catch (error) {
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

