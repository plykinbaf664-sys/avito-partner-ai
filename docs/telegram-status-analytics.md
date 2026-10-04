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

## Release evidence — 2026-10-05 Moscow time

Application/build commit: `e59df22d424d9737cbabcf6c9cda20e0253a818f`.
Typecheck, lint, build and all 545 tests passed locally and in the isolated Linux
candidate. An initial concurrent local check ran out of memory and one test
timed out; after pausing the local dev server, sequential checks passed with
unchanged assertions/timeouts. The local Test Chat Lab was restarted and its
page returned HTTP 200.

Read-only production-database smoke passed before and after deployment. It
exercised the actual command and webhook handler with a recording sender and
in-memory update ledger: active-manager access, sender mismatch denial, duplicate
suppression, missing webhook-secret rejection, message length and response format.
It sent no Telegram/Avito messages, wrote no application records and called no LLM.
Successful Telegram delivery of an actual `/status` reply is left to the normal
manager invocation; it was not claimed from a recording sender.

Telegram getMe/getWebhookInfo succeeded: enabled, two active managers, webhook
configured, zero pending updates and no last webhook error. The running production
POST route rejected a missing secret with HTTP 401. Health/readiness passed;
both services were active/running with zero restarts. The first six observed
polling cycles completed with no error events and handled existing duplicates.

Observed totals: 58 started unique-client dialogs, 56 with a delivered AI reply,
five unique leads delivered to Telegram. The seven-calendar-day window had 16
new dialogs and one transferred lead. Counts are live observations, not constants.
The queue snapshot contained 18 FAILED inbound events already present before
this release, zero pending/failed manager handoffs and zero pending inbound events
after promotion. The report exposes that existing backlog.

Backup/rollback manifest:
`/opt/avito-partner-ai-backups/qwen-migration-20261004-210333/telegram-status-release.json`.
No credentials, networking or schema changed. Before restarting, the release
waited for active customer processing to drain. Rollback keeps the live database
and restores the previous application/build:

```sh
python3 /root/telegram-status-release.py rollback /opt/avito-partner-ai-backups/qwen-migration-20261004-210333/telegram-status-release.json
```
