CREATE TABLE `manager_notifications` (
	`id` text PRIMARY KEY NOT NULL,
	`lead_id` text NOT NULL,
	`conversation_id` text NOT NULL,
	`qualification_status` text NOT NULL,
	`summary` text NOT NULL,
	`idempotency_key` text NOT NULL,
	`delivery_status` text DEFAULT 'PENDING' NOT NULL,
	`delivery_attempts` integer DEFAULT 0 NOT NULL,
	`delivery_retryable` integer,
	`last_delivery_error_code` text,
	`external_notification_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`sent_at` integer,
	FOREIGN KEY (`lead_id`) REFERENCES `leads`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `manager_notifications_idempotency_key_unique` ON `manager_notifications` (`idempotency_key`);--> statement-breakpoint
CREATE INDEX `manager_notifications_delivery_status_idx` ON `manager_notifications` (`delivery_status`);--> statement-breakpoint
CREATE INDEX `manager_notifications_lead_id_idx` ON `manager_notifications` (`lead_id`);--> statement-breakpoint
ALTER TABLE `conversations` ADD `next_inbound_sequence` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `conversations` ADD `last_applied_inbound_sequence` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `leads` ADD `starting_units` integer;--> statement-breakpoint
ALTER TABLE `leads` ADD `scaling_potential_units` integer;--> statement-breakpoint
UPDATE `leads`
SET `starting_units` = `potential_units`
WHERE `starting_units` IS NULL AND `potential_units` IS NOT NULL;--> statement-breakpoint
ALTER TABLE `messages` ADD `sequence` integer;--> statement-breakpoint
ALTER TABLE `messages` ADD `delivery_status` text;--> statement-breakpoint
ALTER TABLE `messages` ADD `delivery_attempts` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `messages` ADD `delivery_retryable` integer;--> statement-breakpoint
ALTER TABLE `messages` ADD `last_delivery_error_code` text;--> statement-breakpoint
ALTER TABLE `messages` ADD `sent_at` integer;
