CREATE TABLE `conversations` (
	`id` text PRIMARY KEY NOT NULL,
	`lead_id` text NOT NULL,
	`state` text DEFAULT 'NEW' NOT NULL,
	`summary` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`closed_at` integer,
	FOREIGN KEY (`lead_id`) REFERENCES `leads`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `conversations_lead_id_idx` ON `conversations` (`lead_id`);--> statement-breakpoint
CREATE INDEX `conversations_state_idx` ON `conversations` (`state`);--> statement-breakpoint
CREATE TABLE `incoming_events` (
	`id` text PRIMARY KEY NOT NULL,
	`source` text NOT NULL,
	`external_event_id` text NOT NULL,
	`external_lead_id` text NOT NULL,
	`payload` text NOT NULL,
	`status` text DEFAULT 'RECEIVED' NOT NULL,
	`error` text,
	`received_at` integer NOT NULL,
	`processing_started_at` integer,
	`processed_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `incoming_events_source_external_id_unique` ON `incoming_events` (`source`,`external_event_id`);--> statement-breakpoint
CREATE INDEX `incoming_events_status_idx` ON `incoming_events` (`status`);--> statement-breakpoint
CREATE TABLE `leads` (
	`id` text PRIMARY KEY NOT NULL,
	`source` text NOT NULL,
	`external_lead_id` text NOT NULL,
	`name` text,
	`contact` text,
	`city` text,
	`budget` integer,
	`budget_confirmed` integer DEFAULT false NOT NULL,
	`potential_units` integer,
	`has_free_time` integer,
	`available_time_details` text,
	`business_experience` text,
	`short_term_rental_experience` text,
	`owns_property` integer,
	`desired_income` integer,
	`primary_goal` text,
	`primary_fear` text,
	`secondary_fear` text,
	`launch_timing` text,
	`management_readiness` text,
	`questions` text DEFAULT '[]' NOT NULL,
	`objections` text DEFAULT '[]' NOT NULL,
	`buying_intent` text,
	`qualification_status` text DEFAULT 'NEW' NOT NULL,
	`qualification_reason` text,
	`conversation_summary` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`handoff_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `leads_source_external_id_unique` ON `leads` (`source`,`external_lead_id`);--> statement-breakpoint
CREATE INDEX `leads_qualification_status_idx` ON `leads` (`qualification_status`);--> statement-breakpoint
CREATE TABLE `messages` (
	`id` text PRIMARY KEY NOT NULL,
	`conversation_id` text NOT NULL,
	`lead_id` text NOT NULL,
	`incoming_event_id` text,
	`direction` text NOT NULL,
	`content` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`lead_id`) REFERENCES `leads`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`incoming_event_id`) REFERENCES `incoming_events`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE UNIQUE INDEX `messages_incoming_event_id_unique` ON `messages` (`incoming_event_id`);--> statement-breakpoint
CREATE INDEX `messages_conversation_id_idx` ON `messages` (`conversation_id`);--> statement-breakpoint
CREATE INDEX `messages_lead_id_idx` ON `messages` (`lead_id`);