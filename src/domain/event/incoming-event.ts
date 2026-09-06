export const incomingEventStatuses = [
  "RECEIVED",
  "PROCESSING",
  "PROCESSED",
  "FAILED",
] as const;

export type IncomingEventStatus = (typeof incomingEventStatuses)[number];

export interface IncomingEvent {
  id: string;
  source: string;
  externalEventId: string;
  externalLeadId: string;
  payload: unknown;
  status: IncomingEventStatus;
  error: string | null;
  extraction: ExtractedMessage | null;
  llmModel: string | null;
  llmInputTokens: number | null;
  llmOutputTokens: number | null;
  llmLatencyMs: number | null;
  totalProcessingLatencyMs: number | null;
  receivedAt: Date;
  processingStartedAt: Date | null;
  processedAt: Date | null;
}
import type { ExtractedMessage } from "../extraction/extracted-message";
