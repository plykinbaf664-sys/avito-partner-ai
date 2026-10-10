ALTER TABLE `conversations` ADD `follow_up_anchor_at` integer;--> statement-breakpoint
ALTER TABLE `conversations` ADD `missed_at` integer;--> statement-breakpoint
-- Preserve recent live episodes, without reviving old dormant conversations
-- or issuing catch-up reminders immediately at release time.
UPDATE conversations SET follow_up_anchor_at = last_outbound_at,
  follow_up_eligible_at = last_outbound_at + 86400000
WHERE awaiting_user_reply = 1 AND qualification_completed = 0
  AND follow_up_count = 0 AND follow_up_eligible_at IS NOT NULL
  AND last_outbound_at >= (unixepoch() * 1000 - 86400000);--> statement-breakpoint
UPDATE conversations SET follow_up_eligible_at = NULL
WHERE follow_up_anchor_at IS NULL;--> statement-breakpoint
UPDATE messages SET delivery_status = 'FAILED', delivery_retryable = 0,
  last_delivery_error_code = 'CANCELLED_BY_FOLLOW_UP_POLICY_CHANGE'
WHERE delivery_status = 'PENDING' AND deduplication_key LIKE 'qualification-follow-up:%';
