ALTER TABLE `incoming_events` ADD `extraction` text;--> statement-breakpoint
ALTER TABLE `incoming_events` ADD `llm_model` text;--> statement-breakpoint
ALTER TABLE `incoming_events` ADD `llm_input_tokens` integer;--> statement-breakpoint
ALTER TABLE `incoming_events` ADD `llm_output_tokens` integer;--> statement-breakpoint
ALTER TABLE `incoming_events` ADD `llm_latency_ms` integer;--> statement-breakpoint
ALTER TABLE `incoming_events` ADD `total_processing_latency_ms` integer;--> statement-breakpoint
ALTER TABLE `leads` ADD `serviceability` text DEFAULT 'NEEDS_REVIEW' NOT NULL;--> statement-breakpoint
ALTER TABLE `messages` ADD `external_message_id` text;