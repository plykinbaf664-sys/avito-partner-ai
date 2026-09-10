import { timingSafeEqual } from "node:crypto";

import { readCrmEnvironment } from "@/config/environment";

export type CrmAccessDecision =
  | "AUTHORIZED"
  | "DISABLED"
  | "UNAUTHORIZED"
  | "MISCONFIGURED";

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return (
    leftBuffer.length === rightBuffer.length &&
    timingSafeEqual(leftBuffer, rightBuffer)
  );
}

export function checkCrmAccess(
  authorization: string | null,
  environment: NodeJS.ProcessEnv = process.env,
): CrmAccessDecision {
  let config: ReturnType<typeof readCrmEnvironment>;
  try {
    config = readCrmEnvironment(environment);
  } catch {
    return "MISCONFIGURED";
  }
  if (!config.enabled) return "DISABLED";
  if (!config.accessToken) return "MISCONFIGURED";
  if (!authorization?.startsWith("Basic ")) return "UNAUTHORIZED";
  try {
    const decoded = Buffer.from(authorization.slice(6), "base64").toString(
      "utf8",
    );
    return safeEqual(decoded, `crm:${config.accessToken}`)
      ? "AUTHORIZED"
      : "UNAUTHORIZED";
  } catch {
    return "UNAUTHORIZED";
  }
}

export function crmAccessResponse(decision: CrmAccessDecision): Response | null {
  if (decision === "AUTHORIZED") return null;
  if (decision === "DISABLED") {
    return new Response("Not Found", { status: 404 });
  }
  if (decision === "MISCONFIGURED") {
    return new Response("Service Unavailable", { status: 503 });
  }
  return new Response("Authentication required", {
    status: 401,
    headers: {
      "WWW-Authenticate": 'Basic realm="Partner CRM", charset="UTF-8"',
      "Cache-Control": "no-store",
    },
  });
}

