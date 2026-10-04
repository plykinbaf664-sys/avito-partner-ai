import Anthropic from "@anthropic-ai/sdk";
import { createMessageExtractor } from "../src/application/extraction/extract-message";
import { createNaturalResponseGenerator } from "../src/application/conversation/generate-natural-response";
import type { LlmTextRequest } from "../src/application/ports/llm-provider";
import { PARTNER_KNOWLEDGE_BASE } from "../src/domain/knowledge/knowledge-base";
import { buildApprovedEconomicsContext } from "../src/domain/economics/economics-calculator";
import type { Lead } from "../src/domain/lead/lead";
import { FakeLLMProvider } from "../src/integrations/fake/fake-llm-provider";
import { prepareAnthropicContext } from "../src/integrations/anthropic/prompt-context";
import { toAnthropicJsonSchema } from "../src/integrations/anthropic/anthropic-llm-provider";
import { readAnthropicConfig } from "../src/integrations/anthropic/config";

// Synthetic fixtures only. No database, channel delivery or generation API calls.
// Optional count_tokens is a free estimate; it does not test actual cache hits.
async function main() {
  const countTokens = process.argv.includes("--count-tokens");
  const client = countTokens ? new Anthropic({ apiKey: readAnthropicConfig(process.env).apiKey, maxRetries: 0 }) : null;
  const now = new Date("2026-10-04T00:00:00Z");
  const lead: Lead = {
    id: "synthetic", source: "EVAL", externalLeadId: "synthetic", name: null, contact: null,
    phoneNumber: null, phoneConfirmed: false, city: "Москва", serviceability: "SUPPORTED",
    budget: 400_000, budgetConfirmed: true, availableCapital: 400_000, availableCapitalConfirmed: true,
    entryBudget: null, additionalLaunchCapital: null, capitalScope: "UNKNOWN", additionalExpensesReadiness: "UNKNOWN",
    businessModelReadiness: "UNKNOWN", segment: "UNDETERMINED", segmentConfidence: 0, startingUnits: 2,
    scalingPotentialUnits: null, hasFreeTime: null, availableTimeDetails: null, businessExperience: null,
    shortTermRentalExperience: null, ownsProperty: null, desiredIncome: null, primaryGoal: null,
    primaryFear: null, secondaryFear: null, launchTiming: null, managementReadiness: null,
    requiresGuaranteedIncome: null, rejectsBusinessModel: null, questions: [], objections: [], buyingIntent: null,
    qualificationStatus: "NEW", qualificationReason: null, conversationSummary: null,
    createdAt: now, updatedAt: now, handoffAt: null,
  };
  const approvedFacts = PARTNER_KNOWLEDGE_BASE.map(({ id, category, answer }) => ({ id, category, answer }));
  for (const historySize of [2, 12]) {
    const recentMessages = Array.from({ length: historySize }, (_, i) => ({
      direction: i % 2 ? "INBOUND" as const : "OUTBOUND" as const,
      actor: i % 2 ? "USER" as const : "AI" as const,
      content: i === historySize - 1 ? "Помогите выбрать первое действие."
        : `Сообщение ${i}: ` + "Обсуждаем запуск бизнеса, участие партнёра и уже известный бюджет. ".repeat(6),
    }));
    const extraction = new FakeLLMProvider(["{}", "{}"]);
    await createMessageExtractor({ llmProvider: extraction })({ text: recentMessages.at(-1)!.content,
      currentLead: lead, recentMessages });
    const generation = new FakeLLMProvider([
      JSON.stringify({ text: "", answerText: "Команда поможет подобрать подходящий объект.", qualificationQuestion: "",
        interpretedQuestionKind: "RECOMMENDATION", usedKnowledgeEntryIds: ["launch-process"] }),
      JSON.stringify({ answerIsSupported: true, answersCurrentRequest: true, optionalQuestionAppropriate: true, feedback: "" }),
    ]);
    await createNaturalResponseGenerator({ llmProvider: generation })({ lead, recentMessages,
      plan: { text: "", nextInformationNeed: null, asksUserQuestion: false, knowledgeEntryIds: [], unresolvedQuestions: [],
        useNaturalAdaptation: true, currentTurnRequiresAnswer: true, approvedFacts,
        economicsContext: buildApprovedEconomicsContext({ city: lead.city, availableCapital: lead.availableCapital, requestedUnits: lead.startingUnits }) } });
    for (const request of [extraction.requests[0]!, ...generation.requests]) {
      const model = readModel(request);
      const prepared = prepareAnthropicContext(request);
      const schema = request.jsonSchema ? toAnthropicJsonSchema(request.jsonSchema) as Record<string, unknown> : null;
      const parameters = { model, ...(schema ? { output_config: { format: { type: "json_schema" as const, schema } } } : {}) };
      const raw = { ...parameters, system: request.systemPrompt,
        messages: [{ role: "user" as const, content: request.userMessage }] };
      const packed = { ...parameters, system: prepared.system,
        messages: [{ role: "user" as const, content: prepared.userMessage }] };
      const result = { historySize, stage: request.metadata?.stage, model,
        beforeFactoringCharacters: JSON.stringify(raw).length, afterFactoringCharacters: JSON.stringify(packed).length,
        beforeFactoringEstimatedInputTokens: null as number | null, afterFactoringEstimatedInputTokens: null as number | null,
        stablePrefixEstimatedTokens: null as number | null };
      if (client) {
        result.beforeFactoringEstimatedInputTokens = (await client.messages.countTokens(raw)).input_tokens;
        result.afterFactoringEstimatedInputTokens = (await client.messages.countTokens(packed)).input_tokens;
        result.stablePrefixEstimatedTokens = (await client.messages.countTokens({ ...packed,
          messages: [{ role: "user", content: "." }] })).input_tokens;
      }
      console.log(JSON.stringify(result));
    }
  }
  console.log(JSON.stringify({ note: "Synthetic current-builder payload before/after factoring; not production usage or a historical baseline. Prefix estimate includes provider/schema overhead. count_tokens estimates may differ from billed usage." }));
}

function readModel(request: LlmTextRequest) {
  if (process.argv.includes("--count-tokens")) return readAnthropicConfig(process.env,
    request.metadata?.stage === "EXTRACTION" ? undefined : "conversation").model;
  return request.metadata?.stage === "EXTRACTION" ? "claude-haiku-4-5" : "claude-sonnet-4-6";
}

main().catch((error: unknown) => {
  console.error("CONTEXT_MEASUREMENT_FAILED", error instanceof Anthropic.APIError ? `HTTP_${error.status}` : "LOCAL_ERROR");
  process.exitCode = 1;
});
