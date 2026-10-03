import { describe, expect, it } from "vitest";
import { readAnthropicConfig } from "./config";

describe("Anthropic model roles", () => {
  const environment = { NODE_ENV: "test" as const, ANTHROPIC_API_KEY: "test-key", ANTHROPIC_MODEL: "claude-haiku-4-5-20251001" };
  it("uses the configured extraction model and a stronger conversation model", () => {
    expect(readAnthropicConfig(environment).model).toBe("claude-haiku-4-5-20251001");
    expect(readAnthropicConfig(environment, "conversation").model).toBe("claude-sonnet-4-6");
  });
  it("allows an explicit conversation model override without changing extraction", () => {
    const custom = { ...environment, ANTHROPIC_CONVERSATION_MODEL: "custom-conversation" };
    expect(readAnthropicConfig(custom, "conversation").model).toBe("custom-conversation");
    expect(readAnthropicConfig(custom).model).toBe(environment.ANTHROPIC_MODEL);
  });
});
