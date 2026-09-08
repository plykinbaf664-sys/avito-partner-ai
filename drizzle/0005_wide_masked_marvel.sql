ALTER TABLE `leads` ADD `available_capital` integer;--> statement-breakpoint
ALTER TABLE `leads` ADD `available_capital_confirmed` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `leads` ADD `entry_budget` integer;--> statement-breakpoint
ALTER TABLE `leads` ADD `additional_launch_capital` integer;--> statement-breakpoint
ALTER TABLE `leads` ADD `capital_scope` text DEFAULT 'UNKNOWN' NOT NULL;--> statement-breakpoint
ALTER TABLE `leads` ADD `additional_expenses_readiness` text DEFAULT 'UNKNOWN' NOT NULL;--> statement-breakpoint
ALTER TABLE `leads` ADD `business_model_readiness` text DEFAULT 'UNKNOWN' NOT NULL;--> statement-breakpoint
ALTER TABLE `leads` ADD `segment` text DEFAULT 'UNDETERMINED' NOT NULL;--> statement-breakpoint
ALTER TABLE `leads` ADD `segment_confidence` real DEFAULT 0 NOT NULL;--> statement-breakpoint
UPDATE `leads`
SET `available_capital` = `budget`,
    `available_capital_confirmed` = `budget_confirmed`
WHERE `budget` IS NOT NULL;--> statement-breakpoint
UPDATE `conversations`
SET `pending_information_need` = 'AVAILABLE_CAPITAL'
WHERE `pending_information_need` = 'BUDGET';
