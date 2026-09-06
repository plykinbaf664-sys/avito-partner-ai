ALTER TABLE `conversations` ADD `pending_information_need` text;--> statement-breakpoint
ALTER TABLE `conversations` ADD `last_inbound_at` integer;--> statement-breakpoint
ALTER TABLE `conversations` ADD `last_outbound_at` integer;--> statement-breakpoint
ALTER TABLE `conversations` ADD `awaiting_user_reply` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `conversations` ADD `qualification_completed` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `conversations` ADD `follow_up_eligible_at` integer;--> statement-breakpoint
ALTER TABLE `conversations` ADD `follow_up_count` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `conversations` ADD `last_follow_up_at` integer;--> statement-breakpoint
CREATE INDEX `conversations_follow_up_due_idx` ON `conversations` (`follow_up_eligible_at`);--> statement-breakpoint
ALTER TABLE `messages` ADD `deduplication_key` text;--> statement-breakpoint
CREATE UNIQUE INDEX `messages_deduplication_key_unique` ON `messages` (`deduplication_key`);