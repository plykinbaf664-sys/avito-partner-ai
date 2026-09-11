import { describe, expect, it, vi } from "vitest";

import { AvitoApiClient, AvitoApiError } from "./avito-api-client";
import { AvitoOutboundMessageProvider } from "./avito-outbound-message-provider";

const request = {
  source: "AVITO",
  conversationId: "conversation-1",
  externalRecipientId: "chat-1",
  text: "Ответ",
  idempotencyKey: "event-response:1",
};

describe("Avito outbound provider", () => {
  it("returns the provider message id after success", async () => {
    const client = { sendTextMessage: vi.fn().mockResolvedValue("message-2") };
    const provider = new AvitoOutboundMessageProvider(
      client as unknown as AvitoApiClient,
    );
    await expect(provider.deliver(request)).resolves.toEqual({
      status: "SENT",
      externalId: "message-2",
    });
  });

  it.each([
    [new AvitoApiError("AVITO_RATE_LIMITED", 429, true), true],
    [new AvitoApiError("AVITO_FORBIDDEN", 403, false), false],
  ])("preserves retryability for safe delivery handling", async (error, retryable) => {
    const client = { sendTextMessage: vi.fn().mockRejectedValue(error) };
    const provider = new AvitoOutboundMessageProvider(
      client as unknown as AvitoApiClient,
    );
    await expect(provider.deliver(request)).resolves.toMatchObject({
      status: "FAILED",
      retryable,
      errorCode: error.code,
    });
  });

  it("fails closed for a non-Avito lead", async () => {
    const client = { sendTextMessage: vi.fn() };
    const provider = new AvitoOutboundMessageProvider(
      client as unknown as AvitoApiClient,
    );
    await expect(provider.deliver({ ...request, source: "LOCAL" })).resolves
      .toMatchObject({ status: "FAILED", retryable: false });
    expect(client.sendTextMessage).not.toHaveBeenCalled();
  });
});

