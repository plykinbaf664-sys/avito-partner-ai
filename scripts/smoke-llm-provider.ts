import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createRuntimeLlmProvider, runtimeLlmIdentity } from "../src/integrations/llm/runtime-provider";
import { SqlitePersistence } from "../src/infrastructure/database/sqlite-persistence";

// Synthetic probe of the configured runtime, never a customer message or handoff.
// --production records usage only in the existing production ledger.
async function main() {
  assert.equal(runtimeLlmIdentity(process.env, "conversation").provider, "qwen", "Qwen must be explicitly selected");
  const production = process.argv.includes("--production");
  const persistence = production ? SqlitePersistence.create(process.env.DATABASE_URL!) : null;
  const rows: unknown[] = [];
  const provider = createRuntimeLlmProvider(process.env, "conversation", {
    workload: production ? "PRODUCTION" : "EVAL", usage: persistence?.llmUsage,
  });
  try {
    for (let run = 0; run < 2; run++) {
      const started = performance.now();
      const result = await provider.generateText({
        systemPrompt: "Верни JSON с answer=READY. Это синтетическая проверка доступности API.\n".repeat(100),
        userMessage: JSON.stringify({ purpose: "DEPLOY_NETWORK_SMOKE", synthetic: true }),
        cache: { stableFields: [], ttl: "5m" }, maxTokens: 120,
        jsonSchema: { type: "object", properties: { answer: { type: "string", const: "READY" } },
          required: ["answer"], additionalProperties: false },
        metadata: { requestId: randomUUID(), stage: "PROVIDER_SMOKE", attempt: 1,
          operation: "EVAL", source: "DEPLOY_SMOKE", promptVersion: "provider-smoke-v1" },
      });
      assert.equal(result.model, "qwen3.8-flash");
      assert.equal(JSON.parse(result.text).answer, "READY");
      await persistence?.llmUsage.settle([result.callId!], "USED");
      rows.push({ provider: result.provider, model: result.model, inputTokens: result.inputTokens,
        outputTokens: result.outputTokens, cacheCreationInputTokens: result.cacheCreationInputTokens,
        cacheReadInputTokens: result.cacheReadInputTokens, latencyMs: Math.round(performance.now() - started),
        estimatedCostMicrousd: result.estimatedCostMicrousd });
    }
    console.log(JSON.stringify({ ok: true, productionConfiguration: production, calls: rows }));
  } finally { persistence?.close(); }
}
main().catch(() => { console.error("LLM_RUNTIME_SMOKE_FAILED"); process.exitCode = 1; });
