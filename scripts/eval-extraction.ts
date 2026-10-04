import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { createMessageExtractor } from "../src/application/extraction/extract-message";
import { createRuntimeLlmProvider } from "../src/integrations/llm/runtime-provider";
import { silentLogger } from "../src/application/observability/structured-logger";

// Synthetic regression only; no production DB or external channels.
async function main() {
  const results = [];
  const modes = process.argv.includes("--compare") ? ["json_schema", "json_object"] :
    [process.env.QWEN_STRUCTURED_OUTPUT ?? "json_object"];
  for (const structuredOutput of modes) {
    const provider = createRuntimeLlmProvider({ ...process.env, QWEN_STRUCTURED_OUTPUT: structuredOutput }, "extraction",
      { workload: "EVAL", logger: silentLogger });
    const result = await createMessageExtractor({ llmProvider: provider })({ text: "Пермь\n100000",
      recentMessages: [{ direction: "OUTBOUND", actor: "MANAGER", content: "Здравствуйте! В каком городе и с каким бюджетом рассматриваете запуск?" }] });
    results.push({ structuredOutput, extraction: result.extraction, diagnostics: result.diagnostics, usage: result.llmUsage });
    console.log(JSON.stringify({ structuredOutput, intent: result.extraction.intent, facts: result.extraction.facts,
      diagnostics: result.diagnostics }));
  }
  const path = process.argv[2];
  if (path) await writeFile(path, JSON.stringify(results, null, 2), "utf8");
  for (const result of results) {
    assert.notEqual(result.extraction.intent, "DECLINE", "Giving city/capital is not opting out");
    assert.equal(result.extraction.facts.availableCapital, 100000);
    assert.equal(result.extraction.facts.rejectsBusinessModel, null);
  }
}
main().catch(() => { console.error("EXTRACTION_EVAL_FAILED"); process.exitCode = 1; });
