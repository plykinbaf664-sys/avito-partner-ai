import { createMessageExtractor } from "../../../application/extraction/extract-message";
import { createNaturalResponseGenerator } from "../../../application/conversation/generate-natural-response";
import { ConsoleStructuredLogger } from "../../../application/observability/structured-logger";
import { createIncomingEventProcessor } from "../../../application/workflows/process-incoming-event";
import { readInboundEnvironment } from "../../../config/environment";
import { SqlitePersistence } from "../../../infrastructure/database/sqlite-persistence";
import { AnthropicLLMProvider } from "../../../integrations/anthropic/anthropic-llm-provider";
import { readAnthropicConfig } from "../../../integrations/anthropic/config";

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
