import { createNaturalResponseGenerator } from "@/application/conversation/generate-natural-response";
import { createMessageExtractor } from "@/application/extraction/extract-message";
import { ConsoleStructuredLogger } from "@/application/observability/structured-logger";
import { createIncomingEventAcceptor } from "@/application/workflows/accept-incoming-event";
import { createIncomingEventProcessor } from "@/application/workflows/process-incoming-event";
import { readAvitoChannelEnvironment, readInboundEnvironment, readTelegramEnvironment } from "@/config/environment";
import { SqlitePersistence } from "@/infrastructure/database/sqlite-persistence";
import { createRuntimeLlmProvider } from "@/integrations/llm/runtime-provider";
import { AvitoApiClient } from "@/integrations/avito/avito-api-client";
import { AvitoOutboundMessageProvider } from "@/integrations/avito/avito-outbound-message-provider";
import { TelegramManagerNotificationProvider } from "@/integrations/telegram/telegram-manager-notification-provider";

export function createRuntimeAvitoWebhook() {
  const avito = readAvitoChannelEnvironment(process.env);
  if (!avito.enabled || !avito.clientId || !avito.clientSecret) {
    return { enabled: false as const };
  }
  const inbound = readInboundEnvironment(process.env);
  const telegram = readTelegramEnvironment(process.env);
  const persistence = SqlitePersistence.create(inbound.DATABASE_URL);
  const logger = new ConsoleStructuredLogger();
  const telemetry = { usage: persistence.llmUsage, logger, workload: "PRODUCTION" as const };
  const llmProvider = createRuntimeLlmProvider(process.env, "extraction", telemetry);
  const conversationProvider = createRuntimeLlmProvider(process.env, "conversation", telemetry);
  const client = new AvitoApiClient({
    clientId: avito.clientId,
    clientSecret: avito.clientSecret,
  });
  const managerNotificationProvider = telegram.enabled
    ? new TelegramManagerNotificationProvider(
        { botToken: telegram.botToken!, logger },
        persistence,
      )
    : undefined;
  const processIncomingEvent = createIncomingEventProcessor({
    persistence,
    extractMessage: createMessageExtractor({ llmProvider }),
    generateNaturalResponse: createNaturalResponseGenerator({ llmProvider: conversationProvider }),
    outboundProvider: new AvitoOutboundMessageProvider(client),
    managerNotificationProvider,
    logger,
  });
  return {
    enabled: true as const,
    client,
    accept: createIncomingEventAcceptor({ persistence, logger }),
    processIncomingEvent,
  };
}
