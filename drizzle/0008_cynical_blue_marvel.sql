CREATE TABLE `telegram_bot_updates` (
	`update_id` text PRIMARY KEY NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `telegram_manager_deliveries` (
	`id` text PRIMARY KEY NOT NULL,
	`manager_notification_id` text NOT NULL,
	`recipient_id` text NOT NULL,
	`idempotency_key` text NOT NULL,
	`delivery_status` text DEFAULT 'PENDING' NOT NULL,
	`delivery_attempts` integer DEFAULT 0 NOT NULL,
	`delivery_retryable` integer,
	`last_delivery_error_code` text,
	`external_message_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`sent_at` integer,
	FOREIGN KEY (`manager_notification_id`) REFERENCES `manager_notifications`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`recipient_id`) REFERENCES `telegram_manager_recipients`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE UNIQUE INDEX `telegram_manager_deliveries_idempotency_key_unique` ON `telegram_manager_deliveries` (`idempotency_key`);--> statement-breakpoint
CREATE INDEX `telegram_manager_deliveries_notification_idx` ON `telegram_manager_deliveries` (`manager_notification_id`);--> statement-breakpoint
CREATE INDEX `telegram_manager_deliveries_recipient_idx` ON `telegram_manager_deliveries` (`recipient_id`);--> statement-breakpoint
CREATE TABLE `telegram_manager_recipients` (
	`id` text PRIMARY KEY NOT NULL,
	`telegram_chat_id` text NOT NULL,
	`telegram_user_id` text NOT NULL,
	`username` text,
	`first_name` text,
	`is_active` integer DEFAULT true NOT NULL,
	`authorized_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `telegram_manager_recipients_chat_id_unique` ON `telegram_manager_recipients` (`telegram_chat_id`);--> statement-breakpoint
CREATE INDEX `telegram_manager_recipients_active_idx` ON `telegram_manager_recipients` (`is_active`);