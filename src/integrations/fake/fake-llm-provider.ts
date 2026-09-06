import type {
  LlmProvider,
  LlmTextRequest,
  LlmTextResponse,
} from "../../application/ports/llm-provider";

export type FakeLlmReply = string | LlmTextResponse | Error;

export class FakeLLMProvider implements LlmProvider {
  readonly requests: LlmTextRequest[] = [];
  private nextReply = 0;

  constructor(private readonly replies: FakeLlmReply[]) {}

  get callCount(): number {
    return this.requests.length;
  }

  async generateText(request: LlmTextRequest): Promise<LlmTextResponse> {
    this.requests.push(request);
    const reply = this.replies[this.nextReply++];
    if (reply === undefined) {
      throw new Error("FakeLLMProvider has no reply configured for this call");
    }
    if (reply instanceof Error) throw reply;
    if (typeof reply === "string") {
      return {
        text: reply,
        model: "fake-model",
        inputTokens: 0,
        outputTokens: 0,
      };
    }
    return reply;
  }
}
