import type {
  OutboundDeliveryRequest,
  OutboundMessageProvider,
  ProviderDeliveryResult,
} from "@/application/ports/channels";

export class FakeOutboundProvider implements OutboundMessageProvider {
  readonly requests: OutboundDeliveryRequest[] = [];
  private readonly delivered = new Map<string, ProviderDeliveryResult>();

  constructor(private readonly results: ProviderDeliveryResult[] = []) {}

  async deliver(
    request: OutboundDeliveryRequest,
  ): Promise<ProviderDeliveryResult> {
    const existing = this.delivered.get(request.idempotencyKey);
    if (existing?.status === "SENT") return existing;
    this.requests.push(request);
    const result = this.results.shift() ?? {
      status: "SENT" as const,
      externalId: `fake-outbound-${this.requests.length}`,
    };
    if (result.status === "SENT") {
      this.delivered.set(request.idempotencyKey, result);
    }
    return result;
  }
}
