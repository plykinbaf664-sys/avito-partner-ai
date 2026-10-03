import { readInboundEnvironment } from "@/config/environment";
import type { AnthropicLlmProviderConfig } from "./anthropic-llm-provider";

export function readAnthropicConfig(
  environment: NodeJS.ProcessEnv,
  role: "extraction" | "conversation" = "extraction",
): AnthropicLlmProviderConfig {
  const parsed = readInboundEnvironment(environment);
  return {
    apiKey: parsed.ANTHROPIC_API_KEY,
    model: role === "conversation" ? parsed.ANTHROPIC_CONVERSATION_MODEL : parsed.ANTHROPIC_MODEL,
    timeoutMs: role === "conversation" ? Math.max(parsed.ANTHROPIC_TIMEOUT_MS, 30_000) : parsed.ANTHROPIC_TIMEOUT_MS,
  };
}
