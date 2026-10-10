import { resolve } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";

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
      processingAttempts: 0,
      processingRetryable: null,
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

describe("independent production SQLite connections", () => {
  it("waits through a short competing writer without losing a polling heartbeat", async () => {
    const directory = await mkdtemp(resolve(tmpdir(), "avito-sqlite-contention-"));
    const url = `file:${resolve(directory, "shared.db").replaceAll("\\", "/")}`;
    const writer = await SqlitePersistence.createMigrated(url);
    const poller = SqlitePersistence.create(url);
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    let acquired!: () => void;
    const ready = new Promise<void>(resolve => { acquired = resolve; });
    const transaction = writer.transaction(async () => {
      acquired();
      await held;
    });
    try {
      await ready;
      const pending = poller.operations.observe("AVITO_POLLING", "OK", null, new Date())
        .then(() => ({ success: true }), error => ({ success: false, error }));
      await new Promise(resolve => setTimeout(resolve, 100));
      release();
      await transaction;
      const result = await pending;
      expect(result).toEqual({ success: true });
      expect(await poller.operations.list()).toMatchObject([{ component: "AVITO_POLLING", state: "OK" }]);
    } finally {
      release();
      await transaction;
      writer.close();
      poller.close();
      await rm(directory, { recursive: true, force: true }).catch((error: NodeJS.ErrnoException) => {
        if (process.platform !== "win32" || error.code !== "EBUSY") throw error;
      });
    }
  }, 15_000);
});
