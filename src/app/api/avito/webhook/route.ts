import { after } from "next/server";

import { createAvitoWebhookHandler } from "./route-handler";
import { createRuntimeAvitoWebhook } from "./runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

let avitoRuntime: ReturnType<typeof createRuntimeAvitoWebhook> | undefined;

function getRuntime() {
  avitoRuntime ??= createRuntimeAvitoWebhook();
  return avitoRuntime;
}

export async function POST(request: Request): Promise<Response> {
  const current = getRuntime();
  if (!current.enabled) {
    return Response.json({ error: "Not found" }, { status: 404 });
  }
  return createAvitoWebhookHandler({
    enabled: true,
    client: current.client,
    accept: current.accept,
    schedule: (input) => {
      after(async () => {
        try {
          await current.processIncomingEvent(input);
        } catch {
          // The event is already persisted with retry metadata. A scheduler can
          // invoke processPendingIncomingEvents after restart/transient failure.
        }
      });
    },
  })(request);
}

