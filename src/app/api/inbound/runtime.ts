import { createMessageExtractor } from "../../../application/extraction/extract-message";
import { createNaturalResponseGenerator } from "../../../application/conversation/generate-natural-response";
import { ConsoleStructuredLogger } from "../../../application/observability/structured-logger";
import { createIncomingEventProcessor } from "../../../application/workflows/process-incoming-event";
import { readInboundEnvironment } from "../../../config/environment";
import { SqlitePersistence } from "../../../infrastructure/database/sqlite-persistence";
import { AnthropicLLMProvider } from "../../../integrations/anthropic/anthropic-llm-provider";
import { readAnthropicConfig } from "../../../integrations/anthropic/config";
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
  const llmProvider = new AnthropicLLMProvider(readAnthropicConfig(process.env));
  return createIncomingEventProcessor({
    persistence,
    extractMessage: createMessageExtractor({ llmProvider }),
    generateNaturalResponse: createNaturalResponseGenerator({ llmProvider }),
    logger: new ConsoleStructuredLogger(),
  });
}
