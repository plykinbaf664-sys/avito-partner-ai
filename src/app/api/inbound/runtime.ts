import { createMessageExtractor } from "../../../application/extraction/extract-message";
import { createNaturalResponseGenerator } from "../../../application/conversation/generate-natural-response";
import { ConsoleStructuredLogger } from "../../../application/observability/structured-logger";
import { createIncomingEventProcessor } from "../../../application/workflows/process-incoming-event";
import {
  readInboundEnvironment,
  readTelegramEnvironment,
} from "../../../config/environment";
import { SqlitePersistence } from "../../../infrastructure/database/sqlite-persistence";
import { createRuntimeLlmProvider } from "../../../integrations/llm/runtime-provider";
import { TelegramManagerNotificationProvider } from "../../../integrations/telegram/telegram-manager-notification-provider";
import type {
  InboundRequestVerifier,
  InboundVerificationResult,
} from "../../../application/ports/inbound-request-verifier";

export function createRuntimeInboundRequestVerifier(
  environment: Pick<NodeJS.ProcessEnv, "NODE_ENV"> = process.env,
): InboundRequestVerifier {
  return {
    async verify(): Promise<InboundVerificationResult> {
      // The generic development endpoint must never become a production
      // webhook merely because credentials are absent. The official Avito
      // adapter will replace this verifier with provider-defined validation.
      return environment.NODE_ENV === "production"
        ? { trusted: false, reason: "AUTH_NOT_CONFIGURED" }
        : { trusted: true };
    },
  };
}

export function createRuntimeInboundProcessor() {
  const environment = readInboundEnvironment(process.env);
  const persistence = SqlitePersistence.create(environment.DATABASE_URL);
  const telemetry = { usage: persistence.llmUsage, logger: new ConsoleStructuredLogger(), workload: "DEVELOPMENT" as const };
  const llmProvider = createRuntimeLlmProvider(process.env, "extraction", telemetry);
  const conversationProvider = createRuntimeLlmProvider(process.env, "conversation", telemetry);
  const telegram = readTelegramEnvironment(process.env);
  const managerNotificationProvider = telegram.enabled
    ? new TelegramManagerNotificationProvider({
        botToken: telegram.botToken!,
        logger: new ConsoleStructuredLogger(),
      }, persistence)
    : undefined;
  return createIncomingEventProcessor({
    persistence,
    extractMessage: createMessageExtractor({ llmProvider }),
    generateNaturalResponse: createNaturalResponseGenerator({ llmProvider: conversationProvider }),
    managerNotificationProvider,
    logger: new ConsoleStructuredLogger(),
  });
}
