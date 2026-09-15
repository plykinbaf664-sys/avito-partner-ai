import { parseArgs } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { createRuntimeAvitoPolling } from "../src/integrations/avito/polling-runtime";

async function main() {
  const { values } = parseArgs({ options: {
    continuous: { type: "boolean", default: false },
    "interval-ms": { type: "string", default: "10000" },
    "chat-id": { type: "string" },
  } });
  const intervalMs = Number(values["interval-ms"]);
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 1_000 || intervalMs > 3_600_000) {
    throw new Error("AVITO_POLL_INVALID_INTERVAL");
  }
  const chatId = values["chat-id"] ?? process.env.AVITO_POLL_CHAT_ID;
  const runtime = await createRuntimeAvitoPolling({ chatId });
  const stop = new AbortController();
  const onStop = () => stop.abort();
  process.on("SIGINT", onStop);
  process.on("SIGTERM", onStop);
  try {
    do {
      const result = await runtime.pollAvitoMessages(new Date());
      console.log(`AVITO_POLLING=${result.status} accepted=${result.accepted} processed=${result.processed} duplicates=${result.duplicates} failed=${result.failed} terminalSkipped=${result.terminalSkipped}`);
      if (!values.continuous) {
        process.exitCode = result.status === "FAIL" ? 1 : 0;
        break;
      }
      // Schedule start-to-start, without adding the API/Claude duration to the
      // requested interval. Slow sweeps run sequentially without overlap.
      const waitMs = Math.max(0, intervalMs - result.durationMs);
      await delay(waitMs, undefined, { signal: stop.signal }).catch((error: unknown) => {
        if (!stop.signal.aborted) throw error;
      });
    } while (!stop.signal.aborted);
  } finally {
    process.off("SIGINT", onStop);
    process.off("SIGTERM", onStop);
    runtime.close();
  }
}

main().catch(() => {
  // Provider exception bodies can contain personal data: never print raw errors.
  console.error("AVITO_POLLING=FAIL reason=RUNTIME_OR_CONFIGURATION_ERROR");
  process.exitCode = 1;
});
