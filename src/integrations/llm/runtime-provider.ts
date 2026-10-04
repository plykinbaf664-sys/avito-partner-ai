import { readInboundEnvironment } from "@/config/environment";
import type { LlmProvider } from "@/application/ports/llm-provider";
import type { LlmCallRecord, LlmUsageRepository } from "@/application/observability/llm-usage";
import type { StructuredLogger } from "@/application/observability/structured-logger";
import { AnthropicLLMProvider } from "../anthropic/anthropic-llm-provider";
import { readAnthropicConfig } from "../anthropic/config";
import { QwenLLMProvider } from "../qwen/qwen-llm-provider";
import { readQwenConfig } from "../qwen/config";

export function createRuntimeLlmProvider(environment: NodeJS.ProcessEnv, role: "extraction" | "conversation",
  telemetry: { usage?: LlmUsageRepository; logger?: StructuredLogger; workload?: LlmCallRecord["workload"]; release?: string } = {}): LlmProvider {
  const { LLM_PROVIDER } = readInboundEnvironment(environment);
  return LLM_PROVIDER === "qwen" ? new QwenLLMProvider(readQwenConfig(environment), undefined, telemetry)
    : new AnthropicLLMProvider(readAnthropicConfig(environment, role), undefined, telemetry);
}

export function runtimeLlmIdentity(environment: NodeJS.ProcessEnv, role: "extraction" | "conversation") {
  const parsed = readInboundEnvironment(environment);
  return { provider: parsed.LLM_PROVIDER, model: parsed.LLM_PROVIDER === "qwen" ? parsed.QWEN_MODEL :
    role === "conversation" ? parsed.ANTHROPIC_CONVERSATION_MODEL : parsed.ANTHROPIC_MODEL! };
}
