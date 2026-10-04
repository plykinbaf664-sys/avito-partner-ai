import type { LlmTextRequest } from "@/application/ports/llm-provider";
import { factorLlmContext } from "../llm/context";

export function prepareAnthropicContext(request: LlmTextRequest) {
  const prepared = factorLlmContext(request);
  if (!request.cache) return { system: prepared.instructions, userMessage: prepared.userMessage };
  return { system: [
    { type: "text" as const, text: prepared.instructions },
    { type: "text" as const, text: prepared.referenceData!, cache_control: request.cache.ttl === "1h"
      ? { type: "ephemeral" as const, ttl: "1h" as const } : { type: "ephemeral" as const } },
  ], userMessage: prepared.userMessage };
}
