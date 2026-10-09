import { createNaturalResponseGenerator } from "@/application/conversation/generate-natural-response";
import { createMessageExtractor } from "@/application/extraction/extract-message";
import { ConsoleStructuredLogger } from "@/application/observability/structured-logger";
import { createDueFollowUpsProcessor } from "@/application/workflows/process-due-follow-ups";
import { createPendingManagerNotificationDelivery } from "@/application/delivery/deliver-pending-manager-notifications";
import { createIncomingEventProcessor } from "@/application/workflows/process-incoming-event";
import { createAvitoMessagePoller } from "@/application/workflows/poll-avito-messages";
import { readAvitoChannelEnvironment, readInboundEnvironment, readTelegramEnvironment } from "@/config/environment";
import { SqlitePersistence } from "@/infrastructure/database/sqlite-persistence";
import { createRuntimeLlmProvider } from "@/integrations/llm/runtime-provider";
import { TelegramManagerNotificationProvider } from "@/integrations/telegram/telegram-manager-notification-provider";
import { AvitoApiClient } from "./avito-api-client";
import { AvitoOutboundMessageProvider } from "./avito-outbound-message-provider";
import { createAvitoRuntimeSafety } from "@/application/health/avito-runtime-safety";

export async function createRuntimeAvitoPolling(options: { chatId?: string } = {}) {
  const avito = readAvitoChannelEnvironment(process.env);
  if (!avito.enabled || !avito.clientId || !avito.clientSecret) {
    throw new Error("AVITO_POLL_CONFIGURATION_REQUIRED");
  }
  const inbound = readInboundEnvironment(process.env);
  const telegram = readTelegramEnvironment(process.env);
  const persistence = await SqlitePersistence.createMigrated(inbound.DATABASE_URL);
  const logger = new ConsoleStructuredLogger();
  const telemetry = { usage: persistence.llmUsage, logger, workload: "PRODUCTION" as const };
  const llmProvider = createRuntimeLlmProvider(process.env, "extraction", telemetry);
  const conversationProvider = createRuntimeLlmProvider(process.env, "conversation", telemetry);
  const client = new AvitoApiClient({
    clientId: avito.clientId,
    clientSecret: avito.clientSecret,
  });
  const naturalResponseGenerator = createNaturalResponseGenerator({ llmProvider: conversationProvider });
  const outboundProvider = new AvitoOutboundMessageProvider(client, logger, persistence.operations);
  const managerNotificationProvider = telegram.enabled
    ? new TelegramManagerNotificationProvider(
        { botToken: telegram.botToken!, logger },
        persistence,
      )
    : undefined;
  const processIncomingEvent = createIncomingEventProcessor({
    persistence,
    extractMessage: createMessageExtractor({ llmProvider }),
    generateNaturalResponse: naturalResponseGenerator,
    outboundProvider,
    managerNotificationProvider,
    logger,
  });
  const safety = createAvitoRuntimeSafety(persistence, processIncomingEvent);
  const poll = createAvitoMessagePoller({ client, persistence, chatId: options.chatId,
    stateRepository: persistence.pollingStates, processIncomingEvent: safety.processIncomingEvent,
    observeHistoryResult: safety.observeHistoryResult, logger });
  const followUps = createDueFollowUpsProcessor({ persistence, outboundProvider,
    generateNaturalResponse: naturalResponseGenerator, logger });
  return {
    pollAvitoMessages: async (now: Date) => {
      const result = await poll(now);
      if (result.status !== "BUSY") await persistence.operations.observe("AVITO_POLLING",
        result.status === "PASS" ? "OK" : "DEGRADED", result.status === "PASS" ? null : "AVITO_POLL_FAILED", new Date());
      return result;
    },
    processDueFollowUps: async (now: Date) => {
      if ((await persistence.operations.list()).some(row => row.component === "AVITO_MESSENGER" && row.state === "BLOCKED")) {
        return { scanned: 0, created: [], sent: [], failed: [], skipped: 0 };
      }
      return followUps(now);
    },
    deliverPendingManagerNotifications: managerNotificationProvider
      ? createPendingManagerNotificationDelivery({
          persistence,
          provider: managerNotificationProvider,
          logger,
        })
      : async () => undefined,
    close: () => persistence.close(),
  };
}
