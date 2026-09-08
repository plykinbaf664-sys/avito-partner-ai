ALTER TABLE `incoming_events` ADD `processing_attempts` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `incoming_events` ADD `processing_retryable` integer;