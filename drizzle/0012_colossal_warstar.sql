CREATE TABLE `llm_calls` (
	`id` text PRIMARY KEY NOT NULL,
	`request_id` text NOT NULL,
	`event_id` text,
	`conversation_id` text,
	`workload` text NOT NULL,
	`stage` text NOT NULL,
	`model` text NOT NULL,
	`status` text NOT NULL,
	`started_at` integer NOT NULL,
	`completed_at` integer,
	`input_tokens` integer,
	`output_tokens` integer,
	`cache_creation_input_tokens` integer,
	`cache_read_input_tokens` integer,
	`estimated_cost_microusd` integer,
	`workflow_outcome` text,
	`details` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `llm_calls_event_idx` ON `llm_calls` (`event_id`);--> statement-breakpoint
CREATE INDEX `llm_calls_request_idx` ON `llm_calls` (`request_id`);--> statement-breakpoint
CREATE INDEX `llm_calls_workload_started_idx` ON `llm_calls` (`workload`,`started_at`);