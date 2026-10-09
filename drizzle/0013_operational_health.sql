CREATE TABLE `operational_health` (
	`component` text PRIMARY KEY NOT NULL,
	`state` text NOT NULL,
	`error_code` text,
	`checked_at` integer NOT NULL,
	`last_success_at` integer,
	`consecutive_failures` integer DEFAULT 0 NOT NULL,
	`alert_fingerprint` text,
	`last_alert_at` integer,
	`last_alert_attempt_at` integer,
	`alert_lease_owner` text,
	`alert_lease_until` integer
);
