import { describe, expect, it } from "vitest";

import { readTestChatLabResponse } from "./test-chat-lab-api";

describe("Test Chat Lab API client", () => {
  it("returns a successful JSON result", async () => {
    const result = { snapshot: { sessionId: "session-1" }, followUp: null };
    const response = Response.json({ ok: true, result });

    await expect(readTestChatLabResponse(response)).resolves.toEqual(result);
  });

  it("reports an HTML framework response before attempting JSON parsing", async () => {
    const response = new Response("<!DOCTYPE html><html><body>Not Found</body></html>", {
      status: 404,
      headers: { "content-type": "text/html; charset=utf-8" },
    });

    await expect(readTestChatLabResponse(response)).rejects.toThrow(
      "HTTP 404 HTML (text/html; charset=utf-8) instead of JSON",
    );
  });

  it("preserves a structured API error and its HTTP status", async () => {
    const response = Response.json(
      { ok: false, error: "TEST_CHAT_LAB_FAILED" },
      { status: 500 },
    );

    await expect(readTestChatLabResponse(response)).rejects.toThrow(
      "TEST_CHAT_LAB_FAILED (HTTP 500)",
    );
  });
});
