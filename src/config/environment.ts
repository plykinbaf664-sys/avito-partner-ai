import { z } from "zod";

type EnvironmentInput = Record<string, string | undefined>;

const nonEmptyOptional = z.preprocess(
  (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
  z.string().trim().min(1).optional(),
);

const booleanFlag = z
  .enum(["true", "false"])
  .default("false")
  .transform((value) => value === "true");

const baseEnvironmentSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  DATABASE_URL: nonEmptyOptional,
  AVITO_CLIENT_ID: nonEmptyOptional,
  AVITO_CLIENT_SECRET: nonEmptyOptional,
  CRM_ENABLED: booleanFlag,
  CRM_ACCESS_TOKEN: nonEmptyOptional,
  TELEGRAM_MANAGER_NOTIFICATIONS_ENABLED: booleanFlag,
  TELEGRAM_BOT_TOKEN: nonEmptyOptional,
  TELEGRAM_MANAGER_INVITE_CODE: nonEmptyOptional,
});

const inboundEnvironmentSchema = baseEnvironmentSchema.extend({
  ANTHROPIC_API_KEY: z.string().trim().min(1),
  ANTHROPIC_MODEL: z.string().trim().min(1),
  ANTHROPIC_TIMEOUT_MS: z.coerce.number().int().positive().default(15_000),
});

export class InvalidEnvironmentError extends Error {
  constructor(readonly fields: string[]) {
    super(`Invalid environment configuration: ${fields.join(", ")}`);
    this.name = "InvalidEnvironmentError";
  }
}

function parseEnvironment<T>(
  schema: z.ZodType<T>,
  environment: EnvironmentInput,
): T {
  const result = schema.safeParse(environment);
  if (result.success) return result.data;
  const fields = [
    ...new Set(result.error.issues.map((issue) => String(issue.path[0] ?? "ENV"))),
  ];
  throw new InvalidEnvironmentError(fields);
}

export function readBaseEnvironment(environment: EnvironmentInput) {
  const parsed = parseEnvironment(baseEnvironmentSchema, environment);
  validateConditionalEnvironment(parsed);
  return {
    ...parsed,
    DATABASE_URL: parsed.DATABASE_URL ?? "file:./data/local.db",
  };
}

export function readInboundEnvironment(environment: EnvironmentInput) {
  const parsed = parseEnvironment(inboundEnvironmentSchema, environment);
  validateConditionalEnvironment(parsed);
  return {
    ...parsed,
    DATABASE_URL: parsed.DATABASE_URL ?? "file:./data/local.db",
  };
}

function validateConditionalEnvironment(parsed: {
  NODE_ENV: "development" | "test" | "production";
  DATABASE_URL?: string;
  CRM_ENABLED: boolean;
  CRM_ACCESS_TOKEN?: string;
  TELEGRAM_MANAGER_NOTIFICATIONS_ENABLED: boolean;
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_MANAGER_INVITE_CODE?: string;
}): void {
  const invalid: string[] = [];
  if (parsed.NODE_ENV === "production" && !parsed.DATABASE_URL) {
    invalid.push("DATABASE_URL");
  }
  if (
    parsed.CRM_ENABLED &&
    (!parsed.CRM_ACCESS_TOKEN || parsed.CRM_ACCESS_TOKEN.length < 16)
  ) {
    invalid.push("CRM_ACCESS_TOKEN");
  }
  if (parsed.TELEGRAM_MANAGER_NOTIFICATIONS_ENABLED) {
    if (!parsed.TELEGRAM_BOT_TOKEN) invalid.push("TELEGRAM_BOT_TOKEN");
    if (
      !parsed.TELEGRAM_MANAGER_INVITE_CODE ||
      !/^[A-Za-z0-9_-]{16,128}$/.test(parsed.TELEGRAM_MANAGER_INVITE_CODE)
    ) invalid.push("TELEGRAM_MANAGER_INVITE_CODE");
  }
  if (invalid.length > 0) throw new InvalidEnvironmentError(invalid);
}

export function readCrmEnvironment(environment: EnvironmentInput) {
  const config = readBaseEnvironment(environment);
  return {
    enabled: config.CRM_ENABLED,
    accessToken: config.CRM_ACCESS_TOKEN ?? null,
    databaseUrl: config.DATABASE_URL,
  };
}

export function readTelegramEnvironment(environment: EnvironmentInput) {
  const config = readBaseEnvironment(environment);
  return {
    enabled: config.TELEGRAM_MANAGER_NOTIFICATIONS_ENABLED,
    botToken: config.TELEGRAM_BOT_TOKEN ?? null,
    inviteCode: config.TELEGRAM_MANAGER_INVITE_CODE ?? null,
    databaseUrl: config.DATABASE_URL,
  };
}

export function validateAvitoEnvironment(environment: EnvironmentInput): void {
  const config = readBaseEnvironment(environment);
  const missing = [
    !config.AVITO_CLIENT_ID ? "AVITO_CLIENT_ID" : null,
    !config.AVITO_CLIENT_SECRET ? "AVITO_CLIENT_SECRET" : null,
  ].filter((field): field is string => field !== null);
  if (missing.length > 0) throw new InvalidEnvironmentError(missing);
}

export function readAvitoEnvironment(environment: EnvironmentInput) {
  validateAvitoEnvironment(environment);
  const config = readBaseEnvironment(environment);
  return {
    clientId: config.AVITO_CLIENT_ID!,
    clientSecret: config.AVITO_CLIENT_SECRET!,
  };
}
