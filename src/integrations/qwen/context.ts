import type { LlmTextRequest } from "@/application/ports/llm-provider";
import { factorLlmContext } from "../llm/context";
import type { QwenConfig } from "./config";

/** Keep Qwen schema constraints. Anthropic's keyword removal does not apply here. */
export function qwenJsonSchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(qwenJsonSchema);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => key !== "$schema" && key !== "default")
    .map(([key, nested]) => key === "const" ? ["enum", [nested]] : [key, qwenJsonSchema(nested)]));
}

export function prepareQwenContext(request: LlmTextRequest, config: Pick<QwenConfig, "cacheMode" | "structuredOutput" | "model"> &
  Partial<Pick<QwenConfig, "thinkingMode" | "thinkingBudget">>) {
  // Real referential evals exposed missed antecedents with pointer-shaped
  // conversation fields. Preserve their literal values; static KB caching and
  // exact economics factoring still reduce context without hiding the exchange.
  const prepared = factorLlmContext(request, { literalConversation: true });
  const schema = request.jsonSchema ? qwenJsonSchema(request.jsonSchema) as Record<string, unknown> : undefined;
  const system = [{ type: "text", text: prepared.instructions },
    ...(prepared.referenceData ? [{ type: "text", text: prepared.referenceData }] : [])];
  if (schema && config.structuredOutput === "json_object") system.push({ type: "text", text:
    "Return one complete JSON object conforming to this schema; no markdown or extra prose. Application validates all fields.\n" + JSON.stringify(schema) });
  const messages = [{ role: "system", content: system.map((block, index) => ({ ...block,
    ...(request.cache && config.cacheMode === "explicit" && index === system.length - 1
      ? { cache_control: { type: "ephemeral" } } : {}) })) }, { role: "user", content: prepared.userMessage }];
  const thinking = config.thinkingMode === "bounded";
  const budget = thinking ? config.thinkingBudget ?? 1024 : 0;
  return { model: config.model, messages, max_tokens: request.maxTokens + budget, stream: false, enable_thinking: thinking,
    ...(thinking ? { thinking_budget: budget } : {}),
    ...(schema ? { response_format: config.structuredOutput === "json_schema"
      ? { type: "json_schema", json_schema: { name: "application_response", strict: true, schema } }
      : { type: "json_object" } } : {}) };
}
