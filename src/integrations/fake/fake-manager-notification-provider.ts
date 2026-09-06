import type {
  ManagerNotificationProvider,
  ManagerNotificationRequest,
  ProviderDeliveryResult,
} from "@/application/ports/channels";

export class FakeManagerNotificationProvider
  implements ManagerNotificationProvider
{
  readonly requests: ManagerNotificationRequest[] = [];
  private readonly delivered = new Map<string, ProviderDeliveryResult>();

  constructor(private readonly results: ProviderDeliveryResult[] = []) {}

  async notify(
    request: ManagerNotificationRequest,
  ): Promise<ProviderDeliveryResult> {
    const existing = this.delivered.get(request.idempotencyKey);
    if (existing?.status === "SENT") return existing;
    this.requests.push(request);
    const result = this.results.shift() ?? {
      status: "SENT" as const,
      externalId: `fake-notification-${this.requests.length}`,
    };
    if (result.status === "SENT") {
      this.delivered.set(request.idempotencyKey, result);
    }
    return result;
  }
}
