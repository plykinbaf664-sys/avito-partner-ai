import { resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { IncomingEvent } from "@/domain/event/incoming-event";

import { SqlitePersistence } from "./sqlite-persistence";

describe("SQLite repositories", () => {
  let persistence: SqlitePersistence;

  beforeEach(async () => {
    persistence = await SqlitePersistence.createMigrated(
      "file::memory:",
      resolve(process.cwd(), "drizzle"),
    );
  });

  afterEach(() => {
    persistence.close();
  });

  it("registers a source event only once", async () => {
    const event: IncomingEvent = {
      id: "event-1",
      source: "test",
      externalEventId: "external-event-1",
      externalLeadId: "external-lead-1",
      payload: { text: "Здравствуйте" },
      status: "RECEIVED",
      error: null,
      extraction: null,
      llmModel: null,
      llmInputTokens: null,
      llmOutputTokens: null,
      llmLatencyMs: null,
      totalProcessingLatencyMs: null,
      receivedAt: new Date("2026-09-03T10:00:00.000Z"),
      processingStartedAt: null,
      processedAt: null,
    };

    const first = await persistence.incomingEvents.register(event);
    const duplicate = await persistence.incomingEvents.register({
      ...event,
      id: "event-2",
    });

    expect(first.created).toBe(true);
    expect(duplicate.created).toBe(false);
    expect(duplicate.event.id).toBe("event-1");
  });
});
