export const MAX_EXTERNAL_DELIVERY_ATTEMPTS = 3;

export function sanitizeExternalErrorCode(value: unknown): string {
  const normalized = String(value)
    .replace(/[^A-Za-z0-9_.:-]/g, "_")
    .slice(0, 100);
  return normalized || "UNKNOWN_ERROR";
}

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

  if (error instanceof Error && "code" in error) {
    return new Set([
      "ECONNRESET",
      "ECONNREFUSED",
      "EHOSTUNREACH",
      "ENETUNREACH",
      "ETIMEDOUT",
      "UND_ERR_CONNECT_TIMEOUT",
      "UND_ERR_HEADERS_TIMEOUT",
    ]).has(String(error.code));
  }

  return error instanceof Error && error.name === "AbortError";
}

export function externalErrorCode(error: unknown): string {
  if (error instanceof Error && "code" in error) {
    return sanitizeExternalErrorCode(error.code);
  }
  return error instanceof Error
    ? sanitizeExternalErrorCode(error.name)
    : "UNKNOWN_ERROR";
}
