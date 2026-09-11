import { describe, expect, it, vi } from "vitest";

import type { AcceptedIncomingEvent } from "@/application/workflows/accept-incoming-event";
import type { AvitoApiClient } from "@/integrations/avito/avito-api-client";

import { createAvitoWebhookHandler } from "./route-handler";

function payload(text = "Здравствуйте") {
  return {
    id: "webhook-event-1",
    payload: {
      type: "message",
      value: {
        author_id: 222,
        chat_id: "chat-1",
        content: { text },
        created: 1_700_000_000,
        id: "message-1",
        type: "text",
        user_id: 111,
      },
    },
    timestamp: 1_700_000_001,
    version: "v3.0",
  };
}

function request(body: unknown): Request {
  return new Request("http://localhost/api/avito/webhook", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("Avito webhook boundary", () => {
  it("verifies the event through Avito before durably accepting and scheduling it", async () => {
    const client = {
      getAuthenticatedAccount: vi.fn().mockResolvedValue({ id: "111" }),
      getInboundMessage: vi.fn().mockResolvedValue({
        id: "message-1",
        authorId: "222",
        createdAtUnix: 1_700_000_000,
        direction: "in",
        type: "text",
        text: "Здравствуйте",
      }),
    };
    const accept = vi.fn().mockImplementation(async (input) => ({
      event: { status: "RECEIVED" },
      input,
      created: true,
      shouldProcess: true,
    }) as AcceptedIncomingEvent);
    const schedule = vi.fn();
    const response = await createAvitoWebhookHandler({
      enabled: true,
      client: client as Pick<AvitoApiClient, "getAuthenticatedAccount" | "getInboundMessage">,
      accept,
      schedule,
    })(request(payload()));

    expect(response.status).toBe(200);
    expect(accept).toHaveBeenCalledWith(expect.objectContaining({
      source: "AVITO",
      externalEventId: "message-1",
      externalLeadId: "chat-1",
      text: "Здравствуйте",
    }));
    expect(schedule).toHaveBeenCalledTimes(1);
  });

  it("does not schedule a forged account or altered message", async () => {
    const schedule = vi.fn();
    const accept = vi.fn();
    const accountMismatch = await createAvitoWebhookHandler({
      enabled: true,
      client: {
        getAuthenticatedAccount: vi.fn().mockResolvedValue({ id: "different" }),
        getInboundMessage: vi.fn(),
      } as unknown as Pick<AvitoApiClient, "getAuthenticatedAccount" | "getInboundMessage">,
      accept,
      schedule,
    })(request(payload()));
    expect(accountMismatch.status).toBe(401);

    const altered = await createAvitoWebhookHandler({
      enabled: true,
      client: {
        getAuthenticatedAccount: vi.fn().mockResolvedValue({ id: "111" }),
        getInboundMessage: vi.fn().mockResolvedValue({
          id: "message-1",
          authorId: "222",
          direction: "in",
          type: "text",
          text: "Настоящий текст",
        }),
      } as unknown as Pick<AvitoApiClient, "getAuthenticatedAccount" | "getInboundMessage">,
      accept,
      schedule,
    })(request(payload("Подменённый текст")));
    expect(altered.status).toBe(401);
    expect(accept).not.toHaveBeenCalled();
    expect(schedule).not.toHaveBeenCalled();
  });

  it("acknowledges an already processed duplicate without scheduling it", async () => {
    const schedule = vi.fn();
    const response = await createAvitoWebhookHandler({
      enabled: true,
      client: {
        getAuthenticatedAccount: vi.fn().mockResolvedValue({ id: "111" }),
        getInboundMessage: vi.fn().mockResolvedValue({
          id: "message-1",
          authorId: "222",
          createdAtUnix: 1_700_000_000,
          direction: "in",
          type: "text",
          text: "Здравствуйте",
        }),
      } as unknown as Pick<AvitoApiClient, "getAuthenticatedAccount" | "getInboundMessage">,
      accept: vi.fn().mockResolvedValue({
        event: { status: "PROCESSED" },
        input: {},
        created: false,
        shouldProcess: false,
      }),
      schedule,
    })(request(payload()));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ duplicate: true });
    expect(schedule).not.toHaveBeenCalled();
  });

  it("is disabled by default and rejects malformed input", async () => {
    const dependencies = {
      client: {} as Pick<AvitoApiClient, "getAuthenticatedAccount" | "getInboundMessage">,
      accept: vi.fn(),
      schedule: vi.fn(),
    };
    expect((await createAvitoWebhookHandler({ enabled: false, ...dependencies })(request(payload()))).status)
      .toBe(404);
    expect((await createAvitoWebhookHandler({ enabled: true, ...dependencies })(request({ bad: true }))).status)
      .toBe(400);
  });
});
