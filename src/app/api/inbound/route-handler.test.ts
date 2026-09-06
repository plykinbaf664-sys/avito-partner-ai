import { resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createMessageExtractor } from "../../../application/extraction/extract-message";
import { createIncomingEventProcessor } from "../../../application/workflows/process-incoming-event";
import { SqlitePersistence } from "../../../infrastructure/database/sqlite-persistence";
import { FakeLLMProvider } from "../../../integrations/fake/fake-llm-provider";

import {
  createInboundPostHandler,
  type InboundSuccessResponse,
} from "./route-handler";

const validExtraction = JSON.stringify({
  intent: "QUALIFICATION_INFORMATION",
  facts: {
    city: "Волгоград",
    budget: 500_000,
    budgetConfirmed: true,
    startingUnits: null,
    scalingPotentialUnits: null,
    hasFreeTime: null,
    availableTimeDetails: null,
    businessExperience: null,
    shortTermRentalExperience: null,
    ownsProperty: null,
    desiredIncome: null,
    primaryGoal: "UNKNOWN",
    launchTiming: "WITHIN_MONTH",
    managementReadiness: null,
    requiresGuaranteedIncome: null,
    rejectsBusinessModel: null,
  },
  signals: {
    questions: [],
    objections: [],
    possiblePrimaryFear: null,
    possibleSecondaryFear: null,
    wantsHuman: false,
  },
  confidence: 0.98,
  uncertainty: [],
});

describe("POST /api/inbound", () => {
  let persistence: SqlitePersistence;

  beforeEach(async () => {
    persistence = await SqlitePersistence.createMigrated(
      "file::memory:",
      resolve(process.cwd(), "drizzle"),
    );
  });

  afterEach(() => persistence.close());

  it("validates and processes a channel-neutral HTTP request", async () => {
    const llm = new FakeLLMProvider([validExtraction]);
    const processEvent = createIncomingEventProcessor({
      persistence,
      extractMessage: createMessageExtractor({ llmProvider: llm }),
    });
    const post = createInboundPostHandler(processEvent);
    const response = await post(
      new Request("http://localhost/api/inbound", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          source: "mock",
          externalEventId: "event-http-1",
          externalLeadId: "lead-http-1",
          messageId: "message-http-1",
          text: "Я из Волгограда, есть 500 тысяч, могу начать через месяц",
        }),
      }),
    );
    const body = (await response.json()) as InboundSuccessResponse;

    expect(response.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.result).toMatchObject({
      eventStatus: "PROCESSED",
      duplicate: false,
      serviceability: "SUPPORTED",
    });
    expect(body.result.extraction?.facts).toMatchObject({
      city: "Волгоград",
      budget: 500_000,
      launchTiming: "WITHIN_MONTH",
    });
  });

  it("returns 400 without calling the LLM for invalid input", async () => {
    const llm = new FakeLLMProvider([validExtraction]);
    const post = createInboundPostHandler(
      createIncomingEventProcessor({
        persistence,
        extractMessage: createMessageExtractor({ llmProvider: llm }),
      }),
    );
    const response = await post(
      new Request("http://localhost/api/inbound", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ source: "mock" }),
      }),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      error: { code: "INVALID_INPUT", retryable: false },
    });
    expect(llm.callCount).toBe(0);
  });
});
