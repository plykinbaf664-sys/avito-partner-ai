import { describe, expect, it } from "vitest";

import {
  InvalidEnvironmentError,
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
  });
});
