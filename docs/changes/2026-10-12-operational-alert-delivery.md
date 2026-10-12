# Operational alert delivery and transient Avito reads

## Evidence and root cause

Production returned intermittent `AVITO_HTTP_500` from Avito on 12 October.
The HTTP status establishes an upstream server error, not its internal cause.
At 11:52 MSK liveness/readiness were HTTP 200 and recent polling cycles passed.
The last observed 500 at the earlier 11:41 check was 11:38 MSK; this does not
establish that Avito has permanently recovered.

Watchdog delivery previously used one incident lease/fingerprint for every
Telegram recipient. A failed recipient made the aggregate unsuccessful and
caused successful recipients to receive duplicates on retry. An exception also
aborted delivery to later recipients. Three new SQLite regression tests failed
before the fix and passed after it.

## Changes

- Additive migration `0016_recipient_operational_alerts` stores delivered
  incident state, attempts, backoff and a fenced lease per recipient/component.
  A successful recipient is not retried because another recipient failed.
  Recovery is delivered only to recipients with a delivered outage warning.
- Preserve legacy successfully delivered incident state when the ledger is
  initialized. Historical partial sends cannot be reconstructed: old logs and
  schema did not retain individual delivery results.
- Isolate send exceptions per recipient. Retry transient failures with bounded
  exponential backoff (1 minute to 30 minutes), permanent failures after six
  hours; explicit recipient reauthorization can release that delay.
- Watchdog logs partial delivery and sanitized errors with hashed recipient
  references. No message text, chat identifiers or credentials are logged.
- Production polling enables one GET retry for a network failure or HTTP 5xx,
  with 500–999 ms jitter. HTTP 402/403/429 do not trigger this retry. POST writes
  are not retried by this transport. Existing outbound reconciliation remains
  responsible for ambiguous delivery. Log only operation, attempt, status and
  sanitized code; API URLs, bodies and headers are excluded.
- Preserve polling fencing. A simulated lost lease confirms no cursor advance,
  no model call/send before recovery and no duplicate reply afterward. Emit
  `AVITO_POLL_LEASE_LOST` as the structured error code instead of generic Error.

## Checks and rollout

Local typecheck, all 648 tests in 49 files, lint and build passed. Repeat these
checks in the isolated Linux candidate. Conversation prompts, schemas, model and qualification policies are
unchanged. Reuse recorded multi-turn evaluations with zero additional paid
agent calls, verify real Avito read access, then deploy through the existing
backup/rollback release helper. Validate readiness, polling, database backlog,
watchdog state and the production Qwen provider smoke after restart.

Rollback switches to the preceding code/build while preserving the additive
table and all customer data. Production env/network settings are unchanged.

## Limits

Client changes cannot prevent Avito outages. Failed reads preserve the recovery
cursor and are retried by subsequent polling cycles after the bounded retry.
Telegram can accept a send and lose its response; without provider idempotency,
absolute exactly-once delivery across that ambiguous network failure cannot
be guaranteed. Persisted confirmed successes are not resent.

The isolated 07:17 MSK polling lease loss lasted less than a second before the
renewal check and was not lease expiry. The next poll recovered. Existing logs
do not identify the actor that cleared/replaced the lease; this change does not
claim to have identified or removed that historical cause.
