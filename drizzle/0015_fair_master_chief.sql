CREATE TABLE `chat_openings` (
	`conversation_id` text PRIMARY KEY NOT NULL,
	`lead_id` text NOT NULL,
	`chat_created_at` integer NOT NULL,
	`eligible_at` integer NOT NULL,
	`status` text NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`lease_owner` text,
	`lease_until` integer,
	`reason` text,
	`response` text,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`lead_id`) REFERENCES `leads`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `chat_openings_due_idx` ON `chat_openings` (`status`,`eligible_at`);
--> statement-breakpoint
CREATE UNIQUE INDEX `chat_openings_lead_unique` ON `chat_openings` (`lead_id`);
