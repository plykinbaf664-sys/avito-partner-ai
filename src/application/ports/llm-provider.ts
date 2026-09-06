export interface LlmTextRequest {
  systemPrompt: string;
  userMessage: string;
  maxTokens: number;
  jsonSchema?: Record<string, unknown>;
}

export interface LlmTextResponse {
  text: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
}

export interface LlmProvider {
  generateText(request: LlmTextRequest): Promise<LlmTextResponse>;
}
