import { describe, expect, it } from "vitest";
import { FakeLLMProvider } from "../../integrations/fake/fake-llm-provider";
import { createInitialLead } from "../workflows/process-incoming-event";
import { createMessageExtractor } from "./extract-message";
import { mergeExtractedFacts } from "./merge-extracted-facts";

const reply = (city: string) => JSON.stringify({ intent: "QUALIFICATION_INFORMATION",
  facts: { city }, signals: { previousQuestionResponse: "ANSWERED", questionKind: "NONE",
    requiresSubstantiveAnswer: false }, confidence: 0.95, uncertainty: [] });
const compact = (replies: string[]) => Object.assign(new FakeLLMProvider(replies), { promptProfile: "compact-v1" as const });

describe("structured city resolution without customer phrase routing", () => {
  it("repairs a location envelope through semantic extraction before deterministic qualification", async () => {
    const llm = compact([reply("Химки, Подмосковье"), reply("Химки")]);
    const lead = createInitialLead("city", "TEST", "synthetic", new Date());
    const result = await createMessageExtractor({ llmProvider: llm })({
      text: "Химки, подмосковье", currentLead: lead,
      recentMessages: [{ direction: "OUTBOUND", actor: "MANAGER", content: "Какой город Вам подходит?" }],
    });
    expect(result.diagnostics?.attempts).toBe(2);
    expect(result.diagnostics?.status).toBe("RECOVERED");
    expect(mergeExtractedFacts(lead, result.extraction, new Date())).toMatchObject({ city: "Химки", serviceability: "SUPPORTED" });
    expect(llm.requests[1].systemPrompt).toContain("facts.city");
  });

  it.each(["г. Химки", "химки", "ВОЛГОГРАД"])("stores a canonical approved name for %s", async city => {
    const llm = compact([reply(city)]);
    const lead = createInitialLead("city", "TEST", "synthetic", new Date());
    const result = await createMessageExtractor({ llmProvider: llm })(city);
    const merged = mergeExtractedFacts(lead, result.extraction, new Date());
    expect(merged.city).toBe(city === "ВОЛГОГРАД" ? "Волгоград" : "Химки");
    expect(merged.serviceability).toBe("SUPPORTED");
  });

  it("does not mark an unknown settlement supported or pick from an unresolved city list", async () => {
    const lead = createInitialLead("city", "TEST", "synthetic", new Date());
    const unknown = await createMessageExtractor({ llmProvider: compact([reply("Тверь")]) })("Тверь");
    expect(mergeExtractedFacts(lead, unknown.extraction, new Date())).toMatchObject({ city: "Тверь", serviceability: "NEEDS_REVIEW" });
    const ambiguous = await createMessageExtractor({ llmProvider: compact([reply("Москва / Химки"), reply("Москва / Химки")]) })("Пока выбираю между Москвой и Химками");
    expect(ambiguous.diagnostics?.status).toBe("DEGRADED");
    expect(mergeExtractedFacts(lead, ambiguous.extraction, new Date()).city).toBeNull();
  });
});
