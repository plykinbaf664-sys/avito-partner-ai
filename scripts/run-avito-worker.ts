import { setTimeout as delay } from "node:timers/promises";
import { parseArgs } from "node:util";

import { externalErrorCode } from "../src/application/delivery/retry-policy";
import { createRuntimeAvitoPolling } from "../src/integrations/avito/polling-runtime";

const INTERVAL_MS = 60_000;

async function main() {
  const { values } = parseArgs({ options: {
    "interval-ms": { type: "string", default: String(INTERVAL_MS) },
  } });
  const intervalMs = Number(values["interval-ms"]);
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 5_000 || intervalMs > 3_600_000) {
    throw new Error("AVITO_WORKER_INVALID_INTERVAL");
  }

  const runtime = await createRuntimeAvitoPolling();
  const stop = new AbortController();
  const onStop = () => stop.abort();
  process.on("SIGINT", onStop);
  process.on("SIGTERM", onStop);

  try {
    // This persisted activation boundary intentionally excludes historical
    // queue entries. Webhook intake itself remains immediate; this worker only
    // recovers post-activation events after a crash or transient failure.
    const recoveryStartedAt = await runtime.activateWebhookRecovery(new Date());
    console.log(`AVITO_WORKER=STARTED recovery_after=${recoveryStartedAt.toISOString()}`);

    while (!stop.signal.aborted) {
      const startedAt = Date.now();
      try {
        const incoming = await runtime.processPendingIncomingEvents(25, recoveryStartedAt);
        await runtime.deliverPendingManagerNotifications();
        const followUps = await runtime.processDueFollowUps(new Date(), recoveryStartedAt);
        const tickFailed = incoming.failed > 0 || followUps.failed.length > 0;
        await runtime.observeWorker(tickFailed ? "DEGRADED" : "OK",
          tickFailed ? "AVITO_WORKER_TICK_PARTIAL" : null, new Date());
        console.log(`AVITO_WORKER=PASS recovered=${incoming.processed} inbound_failed=${incoming.failed} inbound_skipped=${incoming.skipped} followups_sent=${followUps.sent.length} followups_failed=${followUps.failed.length}`);
      } catch (error) {
        // Never print provider response bodies or conversation content.
        await runtime.observeWorker("DEGRADED", "AVITO_WORKER_TICK_FAILED", new Date()).catch(() => undefined);
        console.error(JSON.stringify({ level: "error", event: "avito.worker.tick_failed",
          errorCode: externalErrorCode(error) }));
      }
      const waitMs = Math.max(0, intervalMs - (Date.now() - startedAt));
      if (waitMs > 0) await delay(waitMs, undefined, { signal: stop.signal }).catch((error: unknown) => {
        if (!stop.signal.aborted) throw error;
      });
    }
  } finally {
    process.off("SIGINT", onStop);
    process.off("SIGTERM", onStop);
    runtime.close();
  }
}

main().catch((error: unknown) => {
  console.error("AVITO_WORKER=FAIL reason=RUNTIME_OR_CONFIGURATION_ERROR");
  console.error(JSON.stringify({ level: "error", event: "avito.worker.failed", errorCode: externalErrorCode(error) }));
  process.exitCode = 1;
});
