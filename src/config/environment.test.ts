import { describe, expect, it } from "vitest";

import {
  InvalidEnvironmentError,
  readBaseEnvironment,
  readInboundEnvironment,
  validateAvitoEnvironment,
} from "./environment";

describe("environment validation", () => {
  it("reports missing field names without leaking secret values", () => {
    expect(() =>
      readInboundEnvironment({
        ANTHROPIC_API_KEY: "",
        ANTHROPIC_MODEL: "claude-test",
      }),
    ).toThrowError(new InvalidEnvironmentError(["ANTHROPIC_API_KEY"]));
  });

  it("requires Telegram credentials only when manager notifications are enabled", () => {
    expect(() =>
      readBaseEnvironment({
        TELEGRAM_MANAGER_NOTIFICATIONS_ENABLED: "true",
      }),
    ).toThrowError(InvalidEnvironmentError);
    expect(() =>
      readBaseEnvironment({
        TELEGRAM_MANAGER_NOTIFICATIONS_ENABLED: "true",
        TELEGRAM_BOT_TOKEN: "token",
        TELEGRAM_MANAGER_INVITE_CODE: "strong_invite_code_123",
        TELEGRAM_WEBHOOK_SECRET: "strong_webhook_secret_123",
      }),
    ).not.toThrow();
    expect(() =>
      readBaseEnvironment({
        TELEGRAM_MANAGER_NOTIFICATIONS_ENABLED: "false",
      }),
    ).not.toThrow();
  });

  it("fails closed when CRM is enabled without a sufficiently strong token", () => {
    expect(() => readBaseEnvironment({ CRM_ENABLED: "true" })).toThrowError(
      InvalidEnvironmentError,
    );
    expect(() =>
      readBaseEnvironment({
        CRM_ENABLED: "true",
        CRM_ACCESS_TOKEN: "long-local-secret-token",
      }),
    ).not.toThrow();
  });

  it("requires both Avito credentials only when its provider is enabled", () => {
    expect(() => validateAvitoEnvironment({})).toThrow(
      "AVITO_CLIENT_ID, AVITO_CLIENT_SECRET",
    );
    expect(() =>
      validateAvitoEnvironment({
        AVITO_CLIENT_ID: "id",
        AVITO_CLIENT_SECRET: "secret",
      }),
    ).not.toThrow();
    expect(() =>
      readBaseEnvironment({ AVITO_CHANNEL_ENABLED: "true" }),
    ).toThrowError(InvalidEnvironmentError);
    expect(() =>
      readBaseEnvironment({
        AVITO_CHANNEL_ENABLED: "true",
        AVITO_CLIENT_ID: "id",
        AVITO_CLIENT_SECRET: "secret",
      }),
    ).not.toThrow();
  });

  it("requires an explicit database in production and never falls back to fake providers", () => {
    expect(() =>
      readInboundEnvironment({
        NODE_ENV: "production",
        ANTHROPIC_API_KEY: "configured",
        ANTHROPIC_MODEL: "claude-test",
      }),
    ).toThrowError(new InvalidEnvironmentError(["DATABASE_URL"]));

    expect(() =>
      readInboundEnvironment({
        NODE_ENV: "production",
        DATABASE_URL: "file:./data/production.db",
      }),
    ).toThrowError(InvalidEnvironmentError);
  });
});
