import { beforeEach, describe, expect, it, vi } from "vitest";

const clientMessage = vi.fn();
const managerMessage = vi.fn();
const advanceTime = vi.fn();
const runScenario = vi.fn();
const close = vi.fn();

vi.mock("@/application/test-chat-lab/test-chat-lab-service", () => ({
  createTestChatLabService: vi.fn(() => ({
    clientMessage,
    managerMessage,
    advanceTime,
    runScenario,
  })),
}));

vi.mock("@/infrastructure/database/sqlite-persistence", () => ({
  SqlitePersistence: {
    createMigrated: vi.fn(async () => ({ close })),
  },
}));

vi.mock("@/integrations/anthropic/config", () => ({
  readAnthropicConfig: vi.fn(() => ({ apiKey: "test", model: "test" })),
}));

vi.mock("@/integrations/anthropic/anthropic-llm-provider", () => ({
  AnthropicLLMProvider: class FakeAnthropicLLMProvider {
    constructor(config: unknown) {
      void config;
    }
  },
}));

import { POST } from "./route";

const validAction = {
  action: "client_message",
  sessionId: "route-regression",
  virtualNow: "2026-09-19T10:00:00.000Z",
  text: "Здравствуйте",
};

describe("Test Chat Lab API route", () => {
  beforeEach(() => {
    clientMessage.mockReset();
    managerMessage.mockReset();
    advanceTime.mockReset();
    runScenario.mockReset();
    close.mockReset();
    clientMessage.mockResolvedValue({ snapshot: { sessionId: "route-regression" }, followUp: null });
  });

  it("returns JSON for a real client-message turn instead of a framework HTML error page", async () => {
    const response = await POST(new Request("http://localhost/api/test-chat-lab", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(validAction),
    }));

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      result: { snapshot: { sessionId: "route-regression" } },
    });
    expect(clientMessage).toHaveBeenCalledWith(
      "route-regression",
      "Здравствуйте",
      new Date("2026-09-19T10:00:00.000Z"),
      undefined,
    );
    expect(close).toHaveBeenCalledTimes(1);
  });
});
