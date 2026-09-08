import { describe, expect, it } from "vitest";

import {
  canRetryExternalDelivery,
  isRetryableExternalError,
  MAX_EXTERNAL_DELIVERY_ATTEMPTS,
  sanitizeExternalErrorCode,
} from "./retry-policy";

describe("external delivery retry policy", () => {
  it("retries temporary failures within the bounded attempt limit", () => {
    expect(canRetryExternalDelivery({ attempts: 1, retryable: true })).toBe(true);
    expect(
      canRetryExternalDelivery({
        attempts: MAX_EXTERNAL_DELIVERY_ATTEMPTS,
        retryable: true,
      }),
    ).toBe(false);
  });

  it("does not retry explicit permanent failures", () => {
    expect(canRetryExternalDelivery({ attempts: 1, retryable: false })).toBe(
      false,
    );
  });

  it("classifies 429 and 5xx as temporary but validation errors as permanent", () => {
    expect(isRetryableExternalError(Object.assign(new Error(), { status: 429 }))).toBe(
      true,
    );
    expect(isRetryableExternalError(Object.assign(new Error(), { status: 503 }))).toBe(
      true,
    );
    expect(
      isRetryableExternalError(
        Object.assign(new Error(), { status: 400, retryable: false }),
      ),
    ).toBe(false);
    expect(
      isRetryableExternalError(
        Object.assign(new Error(), { code: "ETIMEDOUT" }),
      ),
    ).toBe(true);
    expect(isRetryableExternalError(new Error("validation failed"))).toBe(
      false,
    );
  });

  it("sanitizes provider error codes before persistence and logging", () => {
    expect(sanitizeExternalErrorCode("TEMP\nsecret=value")).toBe(
      "TEMP_secret_value",
    );
  });
});
