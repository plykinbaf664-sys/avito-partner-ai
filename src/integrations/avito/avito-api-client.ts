import { z } from "zod";

const avitoTokenSchema = z
  .object({
    access_token: z.string().min(1).max(8_192),
    token_type: z.string().min(1).max(32),
    expires_in: z.number().int().positive(),
  })
  .passthrough();

const avitoAccountSchema = z
  .object({
    id: z.union([z.number().int().nonnegative(), z.string().min(1).max(128)]),
    name: z.string().max(512).optional(),
    email: z.string().max(512).optional(),
  })
  .passthrough();

const avitoErrorSchema = z
  .object({
    error: z.string().max(256).optional(),
  })
  .passthrough();

export interface AvitoAccessToken {
  accessToken: string;
  tokenType: string;
  expiresIn: number;
}

export interface AvitoAccountProbe {
  idPresent: true;
  knownFields: string[];
}

export class AvitoApiError extends Error {
  readonly code: string;
  readonly status: number | null;
  readonly retryable: boolean;

  constructor(
    code: string,
    status: number | null,
    retryable: boolean,
  ) {
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
    ["invalid_client", "unauthorized_client", "invalid_grant"].includes(
      providerCode,
    )
  ) {
    return new AvitoApiError("AVITO_INVALID_CREDENTIALS", status, false);
  }
  if (status === 401) return new AvitoApiError("AVITO_UNAUTHORIZED", 401, false);
  if (status === 403) return new AvitoApiError("AVITO_FORBIDDEN", 403, false);
  if (status === 429) return new AvitoApiError("AVITO_RATE_LIMITED", 429, true);
  if (status >= 500) {
    return new AvitoApiError(`AVITO_HTTP_${status}`, status, true);
  }
  return new AvitoApiError(`AVITO_HTTP_${status}`, status, false);
}

async function safeResponsePayload(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

export class AvitoApiClient {
  private readonly config: {
    clientId: string;
    clientSecret: string;
    timeoutMs?: number;
  };
  private readonly fetcher: typeof fetch;

  constructor(
    config: {
      clientId: string;
      clientSecret: string;
      timeoutMs?: number;
    },
    fetcher: typeof fetch = fetch,
  ) {
    this.config = config;
    this.fetcher = fetcher;
  }

  async requestAccessToken(): Promise<AvitoAccessToken> {
    const body = new URLSearchParams({
      grant_type: "client_credentials",
      client_id: this.config.clientId,
      client_secret: this.config.clientSecret,
    });
    const response = await this.request("https://api.avito.ru/token/", {
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
    const response = await this.request(
      "https://api.avito.ru/core/v1/accounts/self",
      {
        method: "GET",
        headers: { Authorization: `Bearer ${accessToken}` },
      },
    );
    const payload = await safeResponsePayload(response);
    if (!response.ok) throw classifyHttpError(response.status, payload);
    const parsed = avitoAccountSchema.safeParse(payload);
    if (!parsed.success) {
      throw new AvitoApiError("AVITO_INVALID_ACCOUNT_RESPONSE", 200, false);
    }
    return {
      idPresent: true,
      knownFields: ["id", "name", "email"].filter(
        (field) => parsed.data[field as "id" | "name" | "email"] !== undefined,
      ),
    };
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
