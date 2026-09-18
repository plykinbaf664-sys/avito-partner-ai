import { resolve } from "node:path";

import { testChatLabActionSchema } from "@/application/test-chat-lab/test-chat-lab-contract";
import { createTestChatLabService } from "@/application/test-chat-lab/test-chat-lab-service";
import { readAnthropicConfig } from "@/integrations/anthropic/config";
import { AnthropicLLMProvider } from "@/integrations/anthropic/anthropic-llm-provider";
import { FakeManagerNotificationProvider } from "@/integrations/fake/fake-manager-notification-provider";
import { FakeOutboundProvider } from "@/integrations/fake/fake-outbound-provider";
import { SqlitePersistence } from "@/infrastructure/database/sqlite-persistence";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function unavailable(): Response {
  return Response.json({ ok: false, error: "TEST_CHAT_LAB_UNAVAILABLE" }, { status: 404 });
}

function testDatabaseUrl(): string {
  const value = process.env.TEST_CHAT_LAB_DATABASE_URL ?? "file:./data/test-chat-lab.db";
  const normalize = (url: string) => url.startsWith("file:")
    ? resolve(/* turbopackIgnore: true */ process.cwd(), url.slice(5))
    : url;
  if (process.env.DATABASE_URL && normalize(value) === normalize(process.env.DATABASE_URL)) {
    throw new Error("TEST_CHAT_LAB_DATABASE_MUST_NOT_BE_PRODUCTION");
  }
  return value;
}

async function withLab<T>(operation: (service: ReturnType<typeof createTestChatLabService>) => Promise<T>): Promise<T> {
  const persistence = await SqlitePersistence.createMigrated(
    testDatabaseUrl(),
    resolve(process.cwd(), "drizzle"),
  );
  try {
    const outboundProvider = new FakeOutboundProvider();
    const managerNotificationProvider = new FakeManagerNotificationProvider();
    const service = createTestChatLabService({
      persistence,
      llmProvider: new AnthropicLLMProvider(readAnthropicConfig(process.env)),
      outboundProvider,
      managerNotificationProvider,
    });
    return await operation(service);
  } finally {
    persistence.close();
  }
}

export async function GET(request: Request): Promise<Response> {
  if (process.env.NODE_ENV === "production") return unavailable();
  const url = new URL(request.url);
  const sessionId = url.searchParams.get("sessionId")?.trim();
  if (!sessionId) return Response.json({ ok: false, error: "SESSION_ID_REQUIRED" }, { status: 400 });
  try {
    const result = await withLab((service) => service.snapshot(sessionId));
    return Response.json({ ok: true, result });
  } catch {
    return Response.json({ ok: false, error: "TEST_CHAT_LAB_FAILED" }, { status: 500 });
  }
}

export async function POST(request: Request): Promise<Response> {
  if (process.env.NODE_ENV === "production") return unavailable();
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ ok: false, error: "INVALID_JSON" }, { status: 400 });
  }
  const parsed = testChatLabActionSchema.safeParse(body);
  if (!parsed.success) return Response.json({ ok: false, error: "INVALID_INPUT" }, { status: 400 });
  const input = parsed.data;
  const now = new Date(input.virtualNow);
  if (!Number.isFinite(now.getTime())) return Response.json({ ok: false, error: "INVALID_TIME" }, { status: 400 });
  if ((input.action === "client_message" || input.action === "manager_message") && !input.text) {
    return Response.json({ ok: false, error: "TEXT_REQUIRED" }, { status: 400 });
  }
  if (input.action === "run_scenario" && !input.scenarioId) {
    return Response.json({ ok: false, error: "SCENARIO_REQUIRED" }, { status: 400 });
  }
  try {
    const result = await withLab(async (service) => {
      switch (input.action) {
        case "client_message":
          return service.clientMessage(input.sessionId, input.text!, now, input.turnId);
        case "manager_message":
          return service.managerMessage(input.sessionId, input.text!, now, input.turnId);
        case "advance_time":
          return service.advanceTime(input.sessionId, now);
        case "run_scenario":
          return service.runScenario(input.sessionId, input.scenarioId!, now);
      }
    });
    return Response.json({ ok: true, result });
  } catch (error) {
    const code = error instanceof Error && error.message === "TEST_CHAT_LAB_SCENARIO_NOT_FOUND"
      ? "SCENARIO_NOT_FOUND"
      : "TEST_CHAT_LAB_FAILED";
    return Response.json({ ok: false, error: code }, { status: code === "SCENARIO_NOT_FOUND" ? 400 : 500 });
  }
}
