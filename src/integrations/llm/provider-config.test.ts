import { describe, expect, it } from "vitest";
import { readInboundEnvironment, InvalidEnvironmentError } from "@/config/environment";

describe("provider selection", () => {
  it("runs Qwen without Anthropic credentials and validates only the selected provider", () => {
    expect(readInboundEnvironment({ LLM_PROVIDER: "qwen", QWEN_API_KEY: "synthetic-secret",
      QWEN_API_HOST: "https://synthetic.ap-southeast-1.maas.aliyuncs.com" })).toMatchObject({
      LLM_PROVIDER: "qwen", QWEN_MODEL: "qwen3.8-flash" });
  });
  it("fails closed instead of using Claude when Qwen credentials are missing", () => {
    expect(() => readInboundEnvironment({ LLM_PROVIDER: "qwen", ANTHROPIC_API_KEY: "configured",
      ANTHROPIC_MODEL: "claude-test" })).toThrowError(new InvalidEnvironmentError(["QWEN_API_KEY", "QWEN_API_HOST"]));
  });
  it("keeps the existing Anthropic selection available without Qwen credentials", () => {
    expect(readInboundEnvironment({ LLM_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "configured",
      ANTHROPIC_MODEL: "claude-haiku-4-5" })).toMatchObject({ LLM_PROVIDER: "anthropic" });
  });
});
