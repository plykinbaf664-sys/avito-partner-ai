export const MAX_EXTERNAL_DELIVERY_ATTEMPTS = 3;

export function canRetryExternalDelivery({
  attempts,
  retryable,
}: {
  attempts: number;
  retryable: boolean | null;
}): boolean {
  return retryable !== false && attempts < MAX_EXTERNAL_DELIVERY_ATTEMPTS;
}

export function isRetryableExternalError(error: unknown): boolean {
  if (error instanceof Error && "retryable" in error) {
    return Boolean(error.retryable);
  }

  if (error instanceof Error && "status" in error) {
    const status = Number(error.status);
    return status === 429 || status >= 500;
  }

  return true;
}

export function externalErrorCode(error: unknown): string {
  if (error instanceof Error && "code" in error) {
    return String(error.code).slice(0, 100);
  }
  return error instanceof Error ? error.name.slice(0, 100) : "UNKNOWN_ERROR";
}
