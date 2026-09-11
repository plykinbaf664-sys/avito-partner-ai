import { describe, expect, it, vi } from "vitest";

import { AvitoApiClient, AvitoApiError } from "./avito-api-client";

describe("Avito API client", () => {
  it("uses client_credentials and validates a read-only account response", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            access_token: "access-token",
            token_type: "Bearer",
            expires_in: 86_400,
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: 123, name: "Account" }), {
          status: 200,
        }),
      );
    const client = new AvitoApiClient(
      { clientId: "client-id", clientSecret: "client-secret" },
      fetcher,
    );

    const token = await client.requestAccessToken();
    await expect(client.getOwnAccount(token.accessToken)).resolves.toEqual({
      idPresent: true,
      knownFields: ["id", "name"],
    });
    expect(fetcher.mock.calls[0]?.[0]).toBe("https://api.avito.ru/token/");
    const body = fetcher.mock.calls[0]?.[1]?.body as URLSearchParams;
    expect(body.get("grant_type")).toBe("client_credentials");
    expect(fetcher.mock.calls[1]?.[1]?.headers).toEqual({
      Authorization: "Bearer access-token",
    });
  });

  it.each([
    [401, "AVITO_UNAUTHORIZED", false],
    [402, "AVITO_MESSENGER_ACCESS_PAYMENT_REQUIRED", false],
    [403, "AVITO_FORBIDDEN", false],
    [429, "AVITO_RATE_LIMITED", true],
    [503, "AVITO_HTTP_503", true],
  ])("maps HTTP %s without response details", async (status, code, retryable) => {
    const client = new AvitoApiClient(
      { clientId: "id", clientSecret: "do-not-leak" },
      vi.fn<typeof fetch>().mockResolvedValue(
        new Response(JSON.stringify({ message: "sensitive provider details" }), {
          status,
        }),
      ),
    );
    const error = await client.requestAccessToken().catch((caught) => caught);
    expect(error).toBeInstanceOf(AvitoApiError);
    expect(error).toMatchObject({ code, status, retryable });
    expect(String(error)).not.toContain("do-not-leak");
    expect(String(error)).not.toContain("sensitive provider details");
  });

  it("recognizes an invalid_client response as invalid credentials", async () => {
    const client = new AvitoApiClient(
      { clientId: "id", clientSecret: "secret" },
      vi.fn<typeof fetch>().mockResolvedValue(
        new Response(JSON.stringify({ error: "invalid_client" }), { status: 400 }),
      ),
    );
    await expect(client.requestAccessToken()).rejects.toMatchObject({
      code: "AVITO_INVALID_CREDENTIALS",
      status: 400,
      retryable: false,
    });
  });

  it("maps network failures as retryable and rejects malformed success bodies", async () => {
    const networkClient = new AvitoApiClient(
      { clientId: "id", clientSecret: "secret" },
      vi.fn<typeof fetch>().mockRejectedValue(new Error("timeout")),
    );
    await expect(networkClient.requestAccessToken()).rejects.toMatchObject({
      code: "AVITO_NETWORK_ERROR",
      status: null,
      retryable: true,
    });

    const malformedClient = new AvitoApiClient(
      { clientId: "id", clientSecret: "secret" },
      vi.fn<typeof fetch>().mockResolvedValue(
        new Response(JSON.stringify({ token: "wrong" }), { status: 200 }),
      ),
    );
    await expect(malformedClient.requestAccessToken()).rejects.toMatchObject({
      code: "AVITO_INVALID_TOKEN_RESPONSE",
      retryable: false,
    });
  });

  it("lists chats/messages and sends text with one cached access token", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        access_token: "access-token",
        token_type: "Bearer",
        expires_in: 86_400,
      })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 123 })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ chats: [{ id: "chat-1" }] })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ messages: [{
        id: "message-1",
        author_id: 456,
        created: 1_700_000_000,
        direction: "in",
        type: "text",
        content: { text: "Здравствуйте" },
      }] })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: "reply-1" })));
    const client = new AvitoApiClient(
      { clientId: "id", clientSecret: "secret" },
      fetcher,
    );

    await expect(client.listChats({ limit: 1 })).resolves.toEqual([
      { id: "chat-1", updatedAtUnix: null },
    ]);
    await expect(client.getInboundMessage("chat-1", "message-1")).resolves
      .toMatchObject({ id: "message-1", text: "Здравствуйте", direction: "in" });
    await expect(client.sendTextMessage("chat-1", "Ответ")).resolves.toBe("reply-1");

    expect(fetcher).toHaveBeenCalledTimes(5);
    expect(String(fetcher.mock.calls[2]?.[0])).toContain("/messenger/v2/");
    expect(String(fetcher.mock.calls[3]?.[0])).toContain("/messenger/v3/");
    expect(fetcher.mock.calls[4]?.[1]?.body).toBe(
      JSON.stringify({ type: "text", message: { text: "Ответ" } }),
    );
  });

  it("rejects invalid outbound text without making an API request", async () => {
    const fetcher = vi.fn<typeof fetch>();
    const client = new AvitoApiClient(
      { clientId: "id", clientSecret: "secret" },
      fetcher,
    );
    await expect(client.sendTextMessage("chat", "")).rejects.toMatchObject({
      code: "AVITO_INVALID_MESSAGE_TEXT",
      retryable: false,
    });
    expect(fetcher).not.toHaveBeenCalled();
  });
});
