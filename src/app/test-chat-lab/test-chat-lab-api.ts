import type { TestChatLabActionResult } from "@/application/test-chat-lab/test-chat-lab-contract";

interface TestChatLabApiEnvelope {
  ok: boolean;
  result?: TestChatLabActionResult;
  error?: string;
}

function responsePreview(body: string): string {
  return body.replace(/\s+/gu, " ").trim().slice(0, 160);
}

export async function readTestChatLabResponse(
  response: Response,
): Promise<TestChatLabActionResult> {
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (!contentType.includes("application/json")) {
    const rawBody = await response.text();
    const bodyKind = /<!doctype\s+html|<html/iu.test(rawBody) ? "HTML" : "non-JSON";
    const preview = responsePreview(rawBody);
    throw new Error(
      `Test Chat Lab API returned HTTP ${response.status} ${bodyKind} ` +
      `(${contentType || "Content-Type missing"}) instead of JSON` +
      (preview ? `: ${preview}` : ""),
    );
  }

  let body: TestChatLabApiEnvelope;
  try {
    body = await response.json() as TestChatLabApiEnvelope;
  } catch {
    throw new Error(
      `Test Chat Lab API returned invalid JSON (HTTP ${response.status})`,
    );
  }

  if (!response.ok || !body.ok || !body.result) {
    throw new Error(`${body.error ?? "TEST_CHAT_LAB_FAILED"} (HTTP ${response.status})`);
  }
  return body.result;
}
