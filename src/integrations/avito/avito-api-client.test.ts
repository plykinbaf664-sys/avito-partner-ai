import { describe, expect, it, vi } from "vitest";

import { AvitoApiClient, AvitoApiError } from "./avito-api-client";

describe("Avito API client", () => {
  it("retries a transient read once with safe operation diagnostics", async () => {
    vi.useFakeTimers();
    try {
      const logger = { info: vi.fn(), error: vi.fn() };
      const fetcher = vi.fn<typeof fetch>()
        .mockResolvedValueOnce(Response.json({ private: "do-not-log" }, { status: 500 }))
        .mockResolvedValueOnce(Response.json({ id: "private-account" }));
      const client = new AvitoApiClient({ clientId: "id", clientSecret: "secret", readRetries: 1, logger }, fetcher);
      const pending = expect(client.getOwnAccount("private-token")).resolves.toMatchObject({ idPresent: true });
      await vi.runAllTimersAsync();
      await pending;
      expect(fetcher).toHaveBeenCalledTimes(2);
      expect(logger.info).toHaveBeenCalledWith("avito.api.retry", expect.objectContaining({ operation: "ACCOUNT", status: 500, attempt: 1 }));
      expect(JSON.stringify(logger.info.mock.calls)).not.toMatch(/private|secret|do-not-log/);
    } finally { vi.useRealTimers(); }
  });

  it.each([500, 402, 429])("bounds HTTP %s read attempts without hiding final failures", async status => {
    vi.useFakeTimers();
    try {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => Response.json({}, { status }));
      const client = new AvitoApiClient({ clientId: "id", clientSecret: "secret", readRetries: 1 }, fetcher);
      const pending = client.getOwnAccount("token").catch(error => error);
      await vi.runAllTimersAsync();
      expect(await pending).toMatchObject({ status });
      expect(fetcher).toHaveBeenCalledTimes(status === 500 ? 2 : 1);
    } finally { vi.useRealTimers(); }
  });

  it("recovers a GET network failure once and never logs the transport exception", async () => {
    vi.useFakeTimers();
    try {
      const logger = { info: vi.fn(), error: vi.fn() };
      const fetcher = vi.fn<typeof fetch>()
        .mockRejectedValueOnce(new Error("private-url-and-secret"))
        .mockResolvedValueOnce(Response.json({ id: 123 }));
      const client = new AvitoApiClient({ clientId: "id", clientSecret: "secret", readRetries: 1, logger }, fetcher);
      const pending = expect(client.getOwnAccount("token")).resolves.toMatchObject({ idPresent: true });
      await vi.runAllTimersAsync(); await pending;
      expect(fetcher).toHaveBeenCalledTimes(2);
      expect(JSON.stringify(logger.info.mock.calls)).not.toContain("private-url-and-secret");
      expect(logger.info).toHaveBeenCalledWith("avito.api.retry", expect.objectContaining({ operation: "ACCOUNT", status: null, errorCode: "AVITO_NETWORK_ERROR" }));
    } finally { vi.useRealTimers(); }
  });

  it("never retries a POST after a transient HTTP failure", async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ access_token: "token", token_type: "Bearer", expires_in: 3600 }))
      .mockResolvedValueOnce(Response.json({ id: 123 }))
      .mockResolvedValueOnce(Response.json({}, { status: 500 }));
    const client = new AvitoApiClient({ clientId: "id", clientSecret: "secret", readRetries: 1 }, fetcher);
    await expect(client.sendTextMessage("chat", "message")).rejects.toMatchObject({ code: "AVITO_HTTP_500" });
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it("exposes verified own-listing discovery metadata without affecting chats with missing metadata", async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ access_token: "test", token_type: "Bearer", expires_in: 3600 }))
      .mockResolvedValueOnce(Response.json({ id: 123 }))
      .mockResolvedValueOnce(Response.json({ chats: [
        { id: "new", created: 1000, context: { type: "item", value: { user_id: 123 } }, users: [{ id: 123 }, { id: 456 }] },
        { id: "unknown", created: "bad", context: { type: "u2u" } },
      ] }));
    const client = new AvitoApiClient({ clientId: "id", clientSecret: "secret" }, fetcher);
    expect(await client.listChats()).toEqual([
      { id: "new", updatedAtUnix: null, createdAtUnix: 1000, contextType: "item", listingOwnerId: "123", participantIds: ["123", "456"] },
      { id: "unknown", updatedAtUnix: null },
    ]);
  });
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

  it.each([
    [403, "AVITO_FORBIDDEN", false],
    [429, "AVITO_RATE_LIMITED", true],
    [500, "AVITO_HTTP_500", true],
    [503, "AVITO_HTTP_503", true],
  ])("maps outbound HTTP %s without blindly resending the POST", async (status, code, retryable) => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ access_token: "test-token", token_type: "Bearer", expires_in: 3600 }))
      .mockResolvedValueOnce(Response.json({ id: 123 }))
      .mockResolvedValueOnce(Response.json({ message: "private provider details" }, { status }));
    const client = new AvitoApiClient({ clientId: "id", clientSecret: "secret" }, fetcher);
    await expect(client.sendTextMessage("chat", "test")).rejects.toMatchObject({ code, status, retryable });
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it.each([200, 401])("refreshes an expired token once on outbound 401 (final HTTP %s)", async (status) => {
    const token = () => Response.json({ access_token: "test-token", token_type: "Bearer", expires_in: 3600 });
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(token())
      .mockResolvedValueOnce(Response.json({ id: 123 }))
      .mockResolvedValueOnce(Response.json({}, { status: 401 }))
      .mockResolvedValueOnce(token())
      .mockResolvedValueOnce(Response.json({ id: "sent" }, { status }));
    const client = new AvitoApiClient({ clientId: "id", clientSecret: "secret" }, fetcher);
    if (status === 200) await expect(client.sendTextMessage("chat", "test")).resolves.toBe("sent");
    else await expect(client.sendTextMessage("chat", "test")).rejects.toMatchObject({ code: "AVITO_UNAUTHORIZED", retryable: false });
    expect(fetcher).toHaveBeenCalledTimes(5);
  });

  it("bounds the outbound request with a timeout and does not automatically resend", async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ access_token: "test-token", token_type: "Bearer", expires_in: 3600 }))
      .mockResolvedValueOnce(Response.json({ id: 123 }))
      .mockImplementationOnce(async (_url, init) => new Promise<Response>((_resolve, reject) => {
        init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason), { once: true });
      }));
    const client = new AvitoApiClient({ clientId: "id", clientSecret: "secret", timeoutMs: 20 }, fetcher);
    await expect(client.sendTextMessage("chat", "test")).rejects.toMatchObject({ code: "AVITO_NETWORK_ERROR", retryable: true });
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it("keeps a response-body timeout retryable instead of reporting a malformed success", async () => {
    const response = new Response();
    vi.spyOn(response, "json").mockRejectedValue(new DOMException("private timeout details", "TimeoutError"));
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ access_token: "test-token", token_type: "Bearer", expires_in: 3600 }))
      .mockResolvedValueOnce(Response.json({ id: 123 }))
      .mockResolvedValueOnce(response);
    const client = new AvitoApiClient({ clientId: "id", clientSecret: "secret" }, fetcher);
    await expect(client.sendTextMessage("chat", "test")).rejects.toMatchObject({ code: "AVITO_NETWORK_ERROR", retryable: true });
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it("validates and normalizes last_message from the authenticated chat list", async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ access_token: "test-token", token_type: "Bearer", expires_in: 3600 }))
      .mockResolvedValueOnce(Response.json({ id: 123 }))
      .mockResolvedValueOnce(Response.json({ chats: [
        { id: "chat", updated: 1, last_message: { id: "preview", author_id: 456,
          created: 1789296591, direction: "in", type: "text", content: { text: "Тест" } } },
        { id: "invalid", last_message: { id: "bad", direction: "in" } },
      ] }));
    const client = new AvitoApiClient({ clientId: "id", clientSecret: "secret" }, fetcher);
    expect(await client.listChats()).toEqual([
      { id: "chat", updatedAtUnix: 1, lastMessage: { id: "preview", authorId: "456",
        createdAtUnix: 1789296591, direction: "in", type: "text", text: "Тест", origin: "CHAT_PREVIEW" } },
      { id: "invalid", updatedAtUnix: null },
    ]);
  });

  it("explicitly requests both item and direct customer chats on every page", async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ access_token: "test-token", token_type: "Bearer", expires_in: 3600 }))
      .mockResolvedValueOnce(Response.json({ id: 123 }))
      .mockImplementation(async url => {
        const query = new URL(String(url)).searchParams;
        return Response.json({ chats: query.get("chat_types") === "u2i,u2u"
          ? [{ id: "u2u-direct-customer", updated: 1791647275 }] : [] });
      });
    const client = new AvitoApiClient({ clientId: "id", clientSecret: "secret" }, fetcher);
    expect(await client.listChats({ limit: 100, offset: 100, unreadOnly: false }))
      .toEqual([{ id: "u2u-direct-customer", updatedAtUnix: 1791647275 }]);
    const query = new URL(String(fetcher.mock.calls.at(-1)![0])).searchParams;
    expect(query.get("offset")).toBe("100");
    expect(query.get("unread_only")).toBe("false");
    expect(query.get("chat_types")).toBe("u2i,u2u");
  });
});
