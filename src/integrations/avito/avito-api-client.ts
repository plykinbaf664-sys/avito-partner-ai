import { z } from "zod";

const AVITO_API_BASE_URL = "https://api.avito.ru";
const externalIdSchema = z.union([
  z.string().min(1).max(255),
  z.number().int().nonnegative(),
]);

const avitoTokenSchema = z.object({
  access_token: z.string().min(1).max(8_192),
  token_type: z.string().min(1).max(32),
  expires_in: z.number().int().positive(),
}).passthrough();
const avitoAccountSchema = z.object({
  id: externalIdSchema,
  name: z.string().max(512).optional(),
  email: z.string().max(512).optional(),
}).passthrough();
const avitoChatSchema = z.object({
  id: externalIdSchema,
  updated: z.number().int().nonnegative().optional(),
}).passthrough();
const avitoChatsResponseSchema = z.object({
  chats: z.array(avitoChatSchema).max(100),
}).passthrough();
const avitoMessageSchema = z.object({
  id: externalIdSchema,
  author_id: externalIdSchema,
  created: z.number().int().nonnegative(),
  direction: z.enum(["in", "out"]),
  type: z.string().min(1).max(64),
  content: z.object({ text: z.string().max(10_000).optional() }).passthrough(),
}).passthrough();
const avitoMessagesResponseSchema = z.object({
  messages: z.array(avitoMessageSchema).max(100),
}).passthrough();
const avitoSentMessageSchema = z.object({ id: externalIdSchema }).passthrough();
const avitoErrorSchema = z.object({
  error: z.string().max(256).optional(),
}).passthrough();

export interface AvitoAccessToken {
  accessToken: string;
  tokenType: string;
  expiresIn: number;
}

export interface AvitoAccount {
  id: string;
  name: string | null;
  email: string | null;
}

export interface AvitoAccountProbe {
  idPresent: true;
  knownFields: string[];
}

export interface AvitoChat {
  id: string;
  updatedAtUnix: number | null;
}

export interface AvitoMessage {
  id: string;
  authorId: string;
  createdAtUnix: number;
  direction: "in" | "out";
  type: string;
  text: string | null;
}

export class AvitoApiError extends Error {
  readonly code: string;
  readonly status: number | null;
  readonly retryable: boolean;

  constructor(code: string, status: number | null, retryable: boolean) {
    super(code);
    this.name = "AvitoApiError";
    this.code = code;
    this.status = status;
    this.retryable = retryable;
  }
}

function classifyHttpError(status: number, payload: unknown): AvitoApiError {
  const parsed = avitoErrorSchema.safeParse(payload);
  const providerCode = parsed.success ? parsed.data.error?.toLowerCase() : null;
  if (
    (status === 400 || status === 401) &&
    providerCode &&
    ["invalid_client", "unauthorized_client", "invalid_grant"].includes(providerCode)
  ) {
    return new AvitoApiError("AVITO_INVALID_CREDENTIALS", status, false);
  }
  if (status === 401) return new AvitoApiError("AVITO_UNAUTHORIZED", 401, false);
  if (status === 402) {
    return new AvitoApiError("AVITO_MESSENGER_ACCESS_PAYMENT_REQUIRED", 402, false);
  }
  if (status === 403) return new AvitoApiError("AVITO_FORBIDDEN", 403, false);
  if (status === 429) return new AvitoApiError("AVITO_RATE_LIMITED", 429, true);
  if (status >= 500) return new AvitoApiError(`AVITO_HTTP_${status}`, status, true);
  return new AvitoApiError(`AVITO_HTTP_${status}`, status, false);
}

async function safeResponsePayload(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

const stringifyId = (value: string | number): string => String(value);

export class AvitoApiClient {
  private cachedToken: { token: string; expiresAt: number } | null = null;
  private cachedAccount: AvitoAccount | null = null;
  private readonly config: {
    clientId: string;
    clientSecret: string;
    timeoutMs?: number;
  };
  private readonly fetcher: typeof fetch;
  private readonly now: () => number;

  constructor(
    config: {
      clientId: string;
      clientSecret: string;
      timeoutMs?: number;
    },
    fetcher: typeof fetch = fetch,
    now: () => number = () => Date.now(),
  ) {
    this.config = config;
    this.fetcher = fetcher;
    this.now = now;
  }

  async requestAccessToken(): Promise<AvitoAccessToken> {
    const body = new URLSearchParams({
      grant_type: "client_credentials",
      client_id: this.config.clientId,
      client_secret: this.config.clientSecret,
    });
    const response = await this.request(`${AVITO_API_BASE_URL}/token/`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
    const payload = await safeResponsePayload(response);
    if (!response.ok) throw classifyHttpError(response.status, payload);
    const parsed = avitoTokenSchema.safeParse(payload);
    if (!parsed.success) {
      throw new AvitoApiError("AVITO_INVALID_TOKEN_RESPONSE", 200, false);
    }
    return {
      accessToken: parsed.data.access_token,
      tokenType: parsed.data.token_type,
      expiresIn: parsed.data.expires_in,
    };
  }

  async getOwnAccount(accessToken: string): Promise<AvitoAccountProbe> {
    const account = await this.getOwnAccountDetails(accessToken);
    return {
      idPresent: true,
      knownFields: ["id", account.name ? "name" : null, account.email ? "email" : null]
        .filter((field): field is string => field !== null),
    };
  }

  async getAuthenticatedAccount(): Promise<AvitoAccount> {
    if (this.cachedAccount) return this.cachedAccount;
    this.cachedAccount = await this.getOwnAccountDetails(await this.accessToken());
    return this.cachedAccount;
  }

  async listChats(options: {
    unreadOnly?: boolean;
    limit?: number;
    offset?: number;
  } = {}): Promise<AvitoChat[]> {
    const account = await this.getAuthenticatedAccount();
    const params = new URLSearchParams({
      limit: String(Math.max(1, Math.min(100, options.limit ?? 50))),
      offset: String(Math.max(0, options.offset ?? 0)),
    });
    if (options.unreadOnly !== undefined) {
      params.set("unread_only", String(options.unreadOnly));
    }
    const payload = await this.authenticatedJson(
      `/messenger/v2/accounts/${encodeURIComponent(account.id)}/chats?${params}`,
      { method: "GET" },
    );
    const parsed = avitoChatsResponseSchema.safeParse(payload);
    if (!parsed.success) {
      throw new AvitoApiError("AVITO_INVALID_CHATS_RESPONSE", 200, false);
    }
    return parsed.data.chats.map((chat) => ({
      id: stringifyId(chat.id),
      updatedAtUnix: chat.updated ?? null,
    }));
  }

  async listMessages(
    chatId: string,
    options: { limit?: number; offset?: number } = {},
  ): Promise<AvitoMessage[]> {
    const account = await this.getAuthenticatedAccount();
    const params = new URLSearchParams({
      limit: String(Math.max(1, Math.min(100, options.limit ?? 100))),
      offset: String(Math.max(0, options.offset ?? 0)),
    });
    const payload = await this.authenticatedJson(
      `/messenger/v3/accounts/${encodeURIComponent(account.id)}/chats/${encodeURIComponent(chatId)}/messages/?${params}`,
      { method: "GET" },
    );
    const parsed = avitoMessagesResponseSchema.safeParse(payload);
    if (!parsed.success) {
      throw new AvitoApiError("AVITO_INVALID_MESSAGES_RESPONSE", 200, false);
    }
    return parsed.data.messages.map((message) => ({
      id: stringifyId(message.id),
      authorId: stringifyId(message.author_id),
      createdAtUnix: message.created,
      direction: message.direction,
      type: message.type,
      text: message.content.text ?? null,
    }));
  }

  async getInboundMessage(chatId: string, messageId: string): Promise<AvitoMessage> {
    const message = (await this.listMessages(chatId, { limit: 100 }))
      .find((candidate) => candidate.id === messageId);
    if (!message || message.direction !== "in") {
      throw new AvitoApiError("AVITO_INBOUND_MESSAGE_NOT_FOUND", 404, false);
    }
    return message;
  }

  async sendTextMessage(chatId: string, text: string): Promise<string> {
    if (text.trim().length === 0 || text.length > 1_000) {
      throw new AvitoApiError("AVITO_INVALID_MESSAGE_TEXT", null, false);
    }
    const account = await this.getAuthenticatedAccount();
    const payload = await this.authenticatedJson(
      `/messenger/v1/accounts/${encodeURIComponent(account.id)}/chats/${encodeURIComponent(chatId)}/messages`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "text", message: { text } }),
      },
    );
    const parsed = avitoSentMessageSchema.safeParse(payload);
    if (!parsed.success) {
      throw new AvitoApiError("AVITO_INVALID_SEND_RESPONSE", 200, false);
    }
    return stringifyId(parsed.data.id);
  }

  async subscribeWebhook(webhookUrl: string): Promise<void> {
    const parsedUrl = z.string().url().safeParse(webhookUrl);
    if (!parsedUrl.success || !webhookUrl.startsWith("https://")) {
      throw new AvitoApiError("AVITO_INVALID_WEBHOOK_URL", null, false);
    }
    await this.authenticatedJson("/messenger/v3/webhook", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: webhookUrl }),
    });
  }

  private async getOwnAccountDetails(accessToken: string): Promise<AvitoAccount> {
    const response = await this.request(`${AVITO_API_BASE_URL}/core/v1/accounts/self`, {
      method: "GET",
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const payload = await safeResponsePayload(response);
    if (!response.ok) throw classifyHttpError(response.status, payload);
    const parsed = avitoAccountSchema.safeParse(payload);
    if (!parsed.success) {
      throw new AvitoApiError("AVITO_INVALID_ACCOUNT_RESPONSE", 200, false);
    }
    return {
      id: stringifyId(parsed.data.id),
      name: parsed.data.name ?? null,
      email: parsed.data.email ?? null,
    };
  }

  private async accessToken(forceRefresh = false): Promise<string> {
    if (!forceRefresh && this.cachedToken && this.cachedToken.expiresAt > this.now()) {
      return this.cachedToken.token;
    }
    const token = await this.requestAccessToken();
    this.cachedToken = {
      token: token.accessToken,
      expiresAt: this.now() + Math.max(1, token.expiresIn - 60) * 1_000,
    };
    return token.accessToken;
  }

  private async authenticatedJson(path: string, init: RequestInit): Promise<unknown> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const token = await this.accessToken(attempt === 1);
      const response = await this.request(`${AVITO_API_BASE_URL}${path}`, {
        ...init,
        headers: { ...init.headers, Authorization: `Bearer ${token}` },
      });
      const payload = await safeResponsePayload(response);
      if (response.status === 401 && attempt === 0) {
        this.cachedToken = null;
        this.cachedAccount = null;
        continue;
      }
      if (!response.ok) throw classifyHttpError(response.status, payload);
      return payload;
    }
    throw new AvitoApiError("AVITO_UNAUTHORIZED", 401, false);
  }

  private async request(url: string, init: RequestInit): Promise<Response> {
    try {
      return await this.fetcher(url, {
        ...init,
        signal: AbortSignal.timeout(this.config.timeoutMs ?? 10_000),
      });
    } catch {
      throw new AvitoApiError("AVITO_NETWORK_ERROR", null, true);
    }
  }
}
