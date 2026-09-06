import { readInboundEnvironment } from "@/config/environment";
import type { AnthropicLlmProviderConfig } from "./anthropic-llm-provider";

export function readAnthropicConfig(
  environment: NodeJS.ProcessEnv,
): AnthropicLlmProviderConfig {
  const parsed = readInboundEnvironment(environment);
  return {
    apiKey: parsed.ANTHROPIC_API_KEY,
    model: parsed.ANTHROPIC_MODEL,
    timeoutMs: parsed.ANTHROPIC_TIMEOUT_MS,
  };
}
