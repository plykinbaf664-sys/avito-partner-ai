import { describe, expect, it } from "vitest";
import { factorLlmContext } from "./context";

describe("approved geographic reference caching", () => {
  const request = { systemPrompt: "Rules", maxTokens: 100, userMessage: JSON.stringify({
    APPROVED_CITY_NAMES: ["Химки", "Волгоград"], CURRENT_MESSAGE: "private customer message",
  }), cache: { stableFields: ["APPROVED_CITY_NAMES"], ttl: "5m" as const } };
  it("caches the catalogue while keeping customer content dynamic", () => {
    const result = factorLlmContext(request);
    expect(result.referenceData).toContain('"APPROVED_CITY_NAMES":["Химки","Волгоград"]');
    expect(result.referenceData).not.toContain("private customer");
    expect(JSON.parse(result.userMessage)).toEqual({ CURRENT_MESSAGE: "private customer message" });
  });
  it("still rejects arbitrary customer context as a stable field", () => {
    expect(() => factorLlmContext({ ...request, cache: { ...request.cache, stableFields: ["CURRENT_MESSAGE"] } }))
      .toThrow("INVALID_CACHE_FIELD");
  });
});
