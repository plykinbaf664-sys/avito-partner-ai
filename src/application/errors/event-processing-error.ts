export class EventProcessingRejectedError extends Error {
  readonly retryable = false;

  constructor() {
    super("Incoming event cannot be retried");
    this.name = "EventProcessingRejectedError";
  }
}
