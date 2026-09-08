import { z } from "zod";

type EnvironmentInput = Record<string, string | undefined>;

const nonEmptyOptional = z.preprocess(
  (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
  z.string().trim().min(1).optional(),
);

const baseEnvironmentSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  DATABASE_URL: nonEmptyOptional,
  AVITO_CLIENT_ID: nonEmptyOptional,
  AVITO_CLIENT_SECRET: nonEmptyOptional,
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
  if (parsed.NODE_ENV === "production" && !parsed.DATABASE_URL) {
    throw new InvalidEnvironmentError(["DATABASE_URL"]);
  }
  return {
    ...parsed,
    DATABASE_URL: parsed.DATABASE_URL ?? "file:./data/local.db",
  };
}

export function readInboundEnvironment(environment: EnvironmentInput) {
  const parsed = parseEnvironment(inboundEnvironmentSchema, environment);
  if (parsed.NODE_ENV === "production" && !parsed.DATABASE_URL) {
    throw new InvalidEnvironmentError(["DATABASE_URL"]);
  }
  return {
    ...parsed,
    DATABASE_URL: parsed.DATABASE_URL ?? "file:./data/local.db",
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
