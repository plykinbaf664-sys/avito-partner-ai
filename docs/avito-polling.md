# Avito Messenger polling fallback

Run from the repository root, using the same `.env.local` and `DATABASE_URL` as
the application. Required settings: `AVITO_CHANNEL_ENABLED=true`,
`AVITO_CLIENT_ID`, `AVITO_CLIENT_SECRET`, `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL`.
Existing Telegram notification configuration is reused when enabled.

```sh
npm run poll:avito
npm run poll:avito -- --continuous --interval-ms 10000
```

For a manual check in the previously used test chat, start this command and wait
for PASS before sending a **new** inbound from the other Avito account:

```sh
npm run poll:avito -- --continuous --interval-ms 10000 --chat-id u2i-MnHIHVe2FTkop58WQbBPjw
```

`--chat-id` (or `AVITO_POLL_CHAT_ID`) restricts both API message intake and durable
event recovery to that chat. It uses its own activation/cursor/lease in the same
SQLite database, leaving the account-wide cursor unchanged. Event/message
deduplication remains shared with ordinary polling and webhooks. Without this
option polling processes all eligible chats. Stop other account-wide pollers
before a manual test if they are running.

The read-only check `npm run smoke:avito -- --chat-id <chat-id>` verifies all five
sampled histories plus the specified chat. Any sampled failure fails the smoke;
an accessible unrelated chat can no longer hide a 402. `AVITO_TEST_CHAT_ID` is
also supported by this smoke command.

The CLI applies additive Drizzle migrations before polling. No Next.js server,
webhook, production scheduler or new worker service is required. Ctrl+C finishes
the active sweep, releases its lease and closes SQLite. Continuous mode schedules
sweep starts every 10 seconds, subtracting the previous sweep's duration from
the wait. If a sweep takes longer, the next starts immediately after it finishes;
it never launches overlapping sweeps. History errors do not increase this interval.

## Data flow

`pollAvitoMessages(now)` lists chats through the existing `AvitoApiClient`,
including read chats. It pages through recent messages, rejects outgoing,
self-authored and system messages, and uses `AvitoInboundChannel` to create
the existing `IncomingPartnerEvent`. `externalEventId` and `messageId` are the
unmodified Avito message ID, exactly as for webhook intake. The client also
validates `last_message` from the authenticated chat-list response. Its timestamp
is considered alongside `chat.updated`, so a stale chat timestamp cannot hide a
newer preview. The same inbound filters apply to previews and history messages.

If history fails (including HTTP 402), a valid preview can still be durably
accepted and processed. Other chats continue to be checked. The sweep remains
FAIL with `historyErrors > 0` and does not advance the cursor: one preview cannot
prove that the complete message history has been ingested. This uses data returned
by the authorized chat endpoint and does not restore unavailable history access.

The fetched batch for each chat is durably accepted before processing, then
passed oldest first to `processIncomingEvent`. This uses the existing Conversation
Engine, qualification, manager notifications and Avito outbound adapter.
No extra LLM calls are used for discovery or deduplication.

`polling_states` contains one row per Avito account: activation timestamp,
last successful sweep's start timestamp, lease owner and lease expiry. The first
successful initialization starts from the current second; it does not reply to
archived conversations. The activation boundary persists across restarts.
Subsequent sweeps re-read five minutes before the last successful sweep, bounded
by activation. All messages on a timestamp boundary are considered. A failed or
incomplete sweep never advances this cursor.

The account lease is claimed atomically in SQLite, including across separate
processes sharing the database. A second poll reports `BUSY`. Lease checks renew
ownership before API calls and processing; an abandoned lease expires after ten
minutes. A former owner cannot release or update a replacement owner's lease.
The existing unique `(source, externalEventId)` and atomic event claims remain
the primary duplicate protection, including concurrent webhook delivery.

Before fetching, each poll recovers up to 100 Avito events from their durable
normalized payload. Existing retry limits and stale processing recovery apply.
This also works when a previously accepted message disappears from Avito results.

## Verification and operations

1. Start continuous polling and wait for the first `AVITO_POLLING=PASS`.
2. Send a new text message from a customer account in Avito.
3. Look for `avito.poll.message` with the Avito `externalEventId`, internal
   `eventId`, `leadId`, `conversationId` and `eventStatus=PROCESSED`.
4. Verify the corresponding `incoming_events` row, one `INBOUND` message and its
   `OUTBOUND` message in SQLite. `delivery_status=SENT` and `external_message_id`
   record successful outbound delivery. Confirm the response in Avito itself.
5. Run another poll: no second inbound, LLM call or outbound is created.

`avito.poll.completed` reports status, chats, fetched/accepted/processed messages,
duplicates, ignored messages, failures, chat/message API request count and total
duration. Authentication requests are not included in that request count.
Existing logs retain extraction latency, tokens, qualification and delivery
status. A polling PASS means ingestion/processing succeeded; outbound delivery
must be checked separately, since the existing delivery workflow tracks its own
errors. Raw message text and credentials are not printed by the polling code.
`chats` counts all unique chats returned, `checkedChats` counts those whose
messages were checked, and `skippedOldChats` counts chats outside the window.
`fetched` includes previews; `previewAccepted` counts new events recovered from
previews during a history failure. `avito.poll.window` records the account ID,
activation, cursor and effective time window; `avito.poll.history_unavailable`
records chat ID and the provider HTTP status without message text.
`avito.poll.new_message` and `avito.poll.duplicate` link the provider message ID
(`externalEventId`) with the internal event ID. During polling,
`avito.outbound.sent` includes `providerMessageId`, `conversationId`, `chatId`
and `latencyMs`; `avito.outbound.failed` includes sanitized error code, HTTP status,
retryability and latency. The existing `outbound.sent` event confirms the SQLite
delivery update. A failed/uncertain POST is not blindly retried by polling.

## Post-upgrade verification, 2026-09-14

OAuth returned HTTP 200 with `expires_in=86400`; the authenticated account is
still `439666639`. The chat list returned 84 chats. All 84 message-history probes
returned HTTP 200, including `u2i-MnHIHVe2FTkop58WQbBPjw` (4 inbound messages).
HTTP 402 was not reproduced by these read-only calls.

A normal poll scoped to the test chat returned PASS and saw 84 chats. Four
continuous sweeps started at 14:00:00.356Z, 14:00:10.364Z, 14:00:20.378Z and
14:00:30.388Z, all PASS. No new test-chat input arrived and no message was sent.
Replaying the previously processed real message ID returned duplicate with zero
extraction calls and an unchanged processing-attempt count of one.

A synthetic message with the live configured Claude model completed extraction,
the existing Conversation Engine, response creation and CRM lookup in isolated
SQLite in 10.5 seconds. Its outbound stayed PENDING because no outbound provider
was enabled for that synthetic probe. This is readiness evidence, not a live
Avito delivery test.

The old outbound failure from September 13 is retained, not reset or resent.
Read access does not prove live send permission: final live delivery and its
provider message ID must be checked with the new manual inbound above.

## Real-account verification, 2026-09-13

Both smoke and polling use account `439666639` and
`GET /messenger/v2/accounts/439666639/chats`. Smoke requests `limit=5&offset=0`;
polling requests `limit=100&offset=0&unread_only=false`. Explicit false and omitted
unread filtering both returned the same chats. Polling saw 69 chats. Previously
`chats` counted only those surviving the timestamp filter, explaining misleading
zero counts. Timestamps were Unix seconds; the local and API clocks agreed.

The specified inbound was found in the authorized chat-list `last_message`:

- Chat: `u2i-MnHIHVe2FTkop58WQbBPjw`
- Message: `bbe508de592c36e847f49c9f7e7eb6bf`
- Timestamp: `2026-09-13T10:49:51Z` (13:49:51 Moscow), `in`, `text`.
- Activation: `10:33:53Z`; cursor: `10:49:16.201Z`; effective window began
  `10:44:16.201Z`. This message passes the time and direction filters.

`GET /messenger/v3/accounts/439666639/chats/{chatId}/messages/` returned HTTP 402
for this chat with limits 1, 20 and 100. Across 69 chats, 7 histories were accessible
and 62 returned 402. A general smoke PASS on another chat therefore does not
establish access to the test chat.

After the change the real message was accepted once and processed through Claude
(`claude-haiku-4-5-20251001`) and the existing Conversation Engine. The real outbound
POST returned `AVITO_MESSENGER_ACCESS_PAYMENT_REQUIRED` (HTTP 402), and its single
outbound row is FAILED. Full delivery verification requires restoring Messenger
access for this chat/account; code changes cannot make that provider rejection
a successful delivery. No fake adapter was used for this verification.

A repeated real poll returned `accepted=0`, `processed=0`, `duplicates=1`.
SQLite confirmed one event, `processing_attempts=1`, one inbound and one outbound
row, with `delivery_attempts=1`. Continuous starts were observed at
`11:02:39.589Z`, `11:02:49.600Z` and `11:02:59.615Z`.
History briefly succeeded during the continuous test, but a subsequent direct
verification returned 402 again. The saved failed outbound was not reset or
resent without restored access. The local diagnostic process was stopped and
its database lease was confirmed released.

## Boundaries

- Polling supports inbound text supported by the current inbound channel.
  Attachments and empty text produce an explicit `unsupported_message` log;
  they are not converted into invented text or passed to the LLM.
- Pagination is bounded to offsets 0–1000, pages of 100. If the recent window
  cannot be exhausted, polling reports FAIL and keeps the cursor. This requires
  operator attention; it never silently claims a complete sweep.
- Five minutes of overlap protects against API visibility delay and moving
  offset pages within that window. A provider delay beyond this window is not
  guaranteed recoverable until the cursor is deliberately rewound. Monitor
  failures and verify the window against real traffic before scheduling.
- SQLite must be shared by polling and the application. Separate database
  copies cannot provide shared idempotency.
- Existing outbound retry/uncertain delivery handling remains unchanged.
  Polling never resends a processed event merely because delivery failed.
  Inspect PENDING/FAILED outbound records using the existing delivery workflow.
- Exhausted or non-retryable incoming processing failures remain visible in
  SQLite and logs and need intervention; polling does not bypass retry limits.
