CREATE TABLE `polling_states` (
	`key` text PRIMARY KEY NOT NULL,
	`started_at` integer NOT NULL,
	`last_completed_at` integer,
	`lease_owner` text,
	`lease_until` integer
);
