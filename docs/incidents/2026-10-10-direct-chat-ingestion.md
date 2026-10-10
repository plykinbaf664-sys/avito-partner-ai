# Direct customer chat missed by polling, 10 October 2026

## Root cause and confirmed event

The customer's initial message at 18:47:55 Moscow time on 10 October and their
later city reply were in a direct user conversation (`u2u`). The manager answered
both manually. The Avito chat-list request omitted `chat_types`; the production
API returned only item conversations (`u2i`) for that request. Polling never saw
this direct conversation, so neither its lead nor incoming events existed in our
database. Healthy polling and a successful history canary did not establish
complete customer-channel coverage. This was our ingestion defect.

A read-only production-server comparison confirmed 151 conversations with the
old request and 153 with `chat_types=u2i,u2u`: two direct chats, one active in the
incident period. Reading that chat's authoritative history confirmed two customer
messages and two later manual replies. No HTTP 402 occurred in these checks.
The last real AI delivery elsewhere was successful; that does not explain away
the absent direct chat.

No customer names, contact details, transcripts or credentials are included here.

## Fix

- `src/integrations/avito/avito-api-client.ts`, `AvitoApiClient.listChats`: always
  request both supported customer-chat types on every page. The shared
  `AVITO_CUSTOMER_CHAT_TYPES` constant excludes Avito service conversations (`a2u`).
- `src/application/workflows/poll-avito-messages.ts`: log the requested chat types
  with the polling window, making the coverage explicit in production telemetry.
  A lease-release failure records a failed cycle and its safe error code instead
  of escaping `finally` and terminating the continuous worker. Existing lease
  ownership/TTL and event/outbound idempotency remain enforced.
- `src/infrastructure/database/sqlite-persistence.ts`: bounded asynchronous retry
  for SQLite BUSY/LOCKED errors through wrapped causes. Per-instance serialization
  did not protect independent app, poller and watchdog connections. Retrying a
  rolled-back database transaction cannot replay LLM calls or transport delivery,
  which are outside those transactions. Other errors are not retried here.
- `src/application/delivery/retry-policy.ts` and `scripts/poll-avito.ts`: preserve
  nested technical error codes without logging raw SQL, parameters, exception
  messages, prompts or customer content.

Four worker exits were observed during the preceding day. Historical logs hid
their underlying exception, so SQLite contention is not asserted as the proven
cause of those particular exits or of this customer's missed messages. The
concurrency defect itself was reproduced with two real connections: the old
code failed with `SQLITE_BUSY` while recording a heartbeat. The fixed code waits
through the competing writer and preserves the observation.

## Regression and verification

New permanent regressions cover:

1. The real API adapter's explicit item/direct filter, including pagination and
   `unread_only=false`. It failed before the fix with the direct chat absent.
2. Multi-turn direct-chat recovery with two human-handled customer turns, CRM
   visibility, both manager messages preserved, no stale AI reply, then exactly
   one reply to a genuinely new customer turn and none on duplicates.
3. A lease-release failure after successful delivery: failed cycle, safe nested
   error code, worker continuity, and no duplicate delivery after lease expiry.
   It failed before the fix by rejecting the entire poll.
4. Real SQLite contention across independent connections, first RED with
   `SQLITE_BUSY`, then PASS.
5. Nested error-code extraction without raw SQL or private message text.

Local full suite: 44 files / 581 tests PASS; typecheck and lint PASS. Production
build and isolated Linux candidate checks are required before promotion.
Conversation prompts, policies, extraction, generation and models are unchanged.
Reuse the previously successful real Qwen trajectory by recorded pipeline replay;
the targeted direct-chat workflow regression verifies ingestion/human protection.
Do not generate a broad new paid dialogue suite for this transport-only change.

## Recovery and release safeguards

Back up database/build/config and retain the previous revision before promotion.
Require healthy liveness/readiness and real production-server Qwen smoke.

Restore only the confirmed missed direct chat using fresh authoritative history:
record the manager's messages, idempotently accept the customer inputs, and allow
the ordinary poller to hydrate/process them through its pending-reference scan.
This needs no broad cursor rewind or replay of old failed deliveries. Pause the
poller during seeding so human history is present before any processing begins.
Existing runtime safety suppresses responses to inputs answered later by the
manager. New customer messages remain eligible for normal AI processing.

Post-release checks must establish: source/build revision, active services and
watchdog, health/readiness, both chat types in actual polling logs, CRM presence,
both missed events processed, human history intact, zero stale AI replies and no
new processing/delivery failures. Record the exact rollback manifest and observed
result in the release addendum.

## Other observed limitation

A separate, already delivered answer about risks in an item conversation used a
financial fallback: validation required another economic rejection on a later
question from a NO_FIT lead. It was not an absent delivery and did not cause this
incident. This release does not claim to correct that conversational-quality
issue; it requires a separate regression and a focused conversation change.
