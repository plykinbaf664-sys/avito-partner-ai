# Telegram /status analytics

`/status` (also `/status@bot_name`) replies in the existing private manager bot.
Analytics are visible only to an active invited manager whose stored Telegram
user ID matches the sender. Inactive/unregistered users receive registration
instructions; group messages remain ignored. Webhook-secret validation,
update deduplication and delivery-failure retry semantics remain in place.

## Metrics and counting rules

All queries use a single SQLite statement and return aggregates, not customer
records or message text. No LLM is involved. No migration or new credentials
are needed.

Source is exactly AVITO, case-insensitive for legacy data. Test Chat Lab and
demo sources do not contribute. Each client (persisted lead identity) is counted
once even if the conversation reopens. The source of truth is the saved history;
the bot cannot report unseen or deleted Avito history or actual sales/payments.

Each report includes today, the current Moscow calendar day plus six preceding
days, and all saved history through the report timestamp. Future timestamps are
excluded. All counts are current database observations, not cached estimates.

| Metric | Definition |
| --- | --- |
| Started dialogs | Unique clients whose first saved USER inbound is in the period. Outbound-only/history placeholders do not start a dialog. |
| With inbound messages | Unique clients with at least one USER inbound in the period, including older dialogs. |
| With AI reply | Unique clients with a successfully delivered AI outbound (`sentAt`) in the period. Pending/failed replies and HUMAN replies are excluded. |
| Transferred to Telegram | Unique leads whose first successful Telegram card delivery (`sentAt`) falls in the period. Multiple managers, duplicate notifications and retries count once. `handoffAt` or a globally SENT notification without a successful Telegram delivery is insufficient. Partial fanout success counts as transferred. |
| New-dialog conversion | Of clients whose first saved inbound is in the period, how many have a successful Telegram handoff by report time. It is **not** period handoffs divided by period starts, which can exceed 100% when old clients are handed off today. With zero starts the value is undefined (`—`). Recent cohorts have had less time to qualify. |

The current backlog includes qualified clients with `PHONE_UNKNOWN` and no
confirmed phone or successful handoff, unique leads with PENDING/FAILED manager
notifications, and RECEIVED/PROCESSING/FAILED Avito inbound events. Failed manager
notifications can include partial fanout failures: one manager has already
received the card while another delivery still needs attention. Counts describe
the persisted queue; they do not imply that an exhausted failure will auto-retry.

The Telegram response contains no customer names, phone numbers or transcript.
The existing recipient's own Chat ID remains for subscription support.

## Verification

Permanent coverage includes empty data, zero denominator, Moscow midnight and
seven-day boundaries, old-client handoff versus cohort conversion, multiple
recipients/retries, partial delivery, unconfirmed handoff flags, demo/eval/future
data exclusion, ingestion backlog, active-manager authorization, duplicate
updates, stopped subscriptions and retry after a failed command response.

Only reporting, repository wiring and Telegram command handling changed.
Conversation prompts, qualification, economics, handoff execution and networking
are unchanged. Paid conversational evals are unnecessary for this isolated change.
