import { createNaturalResponseGenerator } from "@/application/conversation/generate-natural-response";
import { createMessageExtractor } from "@/application/extraction/extract-message";
import { ConsoleStructuredLogger } from "@/application/observability/structured-logger";
import { createDueFollowUpsProcessor } from "@/application/workflows/process-due-follow-ups";
import { createPendingManagerNotificationDelivery } from "@/application/delivery/deliver-pending-manager-notifications";
import { createIncomingEventProcessor } from "@/application/workflows/process-incoming-event";
import { createAvitoMessagePoller } from "@/application/workflows/poll-avito-messages";
import { readAvitoChannelEnvironment, readInboundEnvironment, readTelegramEnvironment } from "@/config/environment";
import { SqlitePersistence } from "@/infrastructure/database/sqlite-persistence";
import { AnthropicLLMProvider } from "@/integrations/anthropic/anthropic-llm-provider";
import { readAnthropicConfig } from "@/integrations/anthropic/config";
import { TelegramManagerNotificationProvider } from "@/integrations/telegram/telegram-manager-notification-provider";
import { AvitoApiClient } from "./avito-api-client";
import { AvitoOutboundMessageProvider } from "./avito-outbound-message-provider";

export async function createRuntimeAvitoPolling(options: { chatId?: string } = {}) {
  const avito = readAvitoChannelEnvironment(process.env);
  if (!avito.enabled || !avito.clientId || !avito.clientSecret) {
    throw new Error("AVITO_POLL_CONFIGURATION_REQUIRED");
  }
  const inbound = readInboundEnvironment(process.env);
  const telegram = readTelegramEnvironment(process.env);
  const llmProvider = new AnthropicLLMProvider(readAnthropicConfig(process.env));
  const persistence = await SqlitePersistence.createMigrated(inbound.DATABASE_URL);
  const logger = new ConsoleStructuredLogger();
  const client = new AvitoApiClient({
    clientId: avito.clientId,
    clientSecret: avito.clientSecret,
  });
  const naturalResponseGenerator = createNaturalResponseGenerator({ llmProvider });
  const outboundProvider = new AvitoOutboundMessageProvider(client, logger);
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
  return {
    pollAvitoMessages: createAvitoMessagePoller({
      client,
      persistence,
      chatId: options.chatId,
      stateRepository: persistence.pollingStates,
      processIncomingEvent,
      logger,
    }),
    processDueFollowUps: createDueFollowUpsProcessor({
      persistence,
      outboundProvider,
      generateNaturalResponse: naturalResponseGenerator,
      logger,
    }),
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
