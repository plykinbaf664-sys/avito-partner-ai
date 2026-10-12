CREATE TABLE `operational_alert_deliveries` (
	`id` text PRIMARY KEY NOT NULL,
	`component` text NOT NULL,
	`recipient_id` text NOT NULL,
	`alert_fingerprint` text,
	`last_alert_at` integer,
	`last_attempt_at` integer,
	`next_attempt_at` integer,
	`failures` integer DEFAULT 0 NOT NULL,
	`last_error_code` text,
	`external_message_id` text,
	`lease_owner` text,
	`lease_until` integer,
	FOREIGN KEY (`recipient_id`) REFERENCES `telegram_manager_recipients`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `operational_alert_recipient_unique` ON `operational_alert_deliveries` (`component`,`recipient_id`);