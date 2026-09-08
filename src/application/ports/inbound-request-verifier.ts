export interface InboundVerificationRequest {
  headers: Headers;
  rawBody: Uint8Array;
}

export type InboundVerificationResult =
  | { trusted: true }
  | {
      trusted: false;
      reason: "AUTH_NOT_CONFIGURED" | "UNAUTHORIZED";
    };

/**
 * Authentication boundary for a future official channel adapter. Idempotency
 * is deliberately not treated as authentication. Signature verification must
 * use the provider's official protocol and the original body bytes.
 */
export interface InboundRequestVerifier {
  verify(
    request: InboundVerificationRequest,
  ): Promise<InboundVerificationResult>;
}
