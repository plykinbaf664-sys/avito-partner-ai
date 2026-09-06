export class RetryableInfrastructureError extends Error {
  readonly retryable = true;

  constructor(
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "RetryableInfrastructureError";
  }
}
