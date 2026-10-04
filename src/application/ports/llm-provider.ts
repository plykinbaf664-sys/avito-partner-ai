import type { LlmCallContext, LlmUsageTotals } from "../observability/llm-usage";

export interface LlmTextRequest {
  systemPrompt: string;
  userMessage: string;
  maxTokens: number;
  jsonSchema?: Record<string, unknown>;
  cache?: { stableFields: string[]; ttl: "5m" | "1h"; systemPrefix?: string };
  metadata?: LlmCallContext & { stage: string; attempt: number; promptVersion: string };
}

export interface LlmTextResponse {
  text: string;
  model: string;
  provider?: "anthropic" | "qwen";
  inputTokens: number;
  outputTokens: number;
  callId?: string;
  cacheCreationInputTokens?: number;
  cacheReadInputTokens?: number;
  estimatedCostMicrousd?: number | null;
}

export interface LlmProvider {
  readonly promptProfile?: "compact-v1";
  generateText(request: LlmTextRequest): Promise<LlmTextResponse>;
  annotateCall?(callId: string | undefined, outcome: "ACCEPTED" | "REJECTED", errorCode?: string): Promise<void>;
}

export interface LlmUsageError extends Error { llmUsage?: LlmUsageTotals }
