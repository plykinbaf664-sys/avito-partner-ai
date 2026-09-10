ALTER TABLE `leads` ADD `phone_number` text;--> statement-breakpoint
ALTER TABLE `leads` ADD `phone_confirmed` integer DEFAULT false NOT NULL;