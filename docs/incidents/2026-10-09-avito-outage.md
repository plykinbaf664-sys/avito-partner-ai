# Avito auto-reply incident, 9 October 2026

## Confirmed causes

- At 15:13:51 Moscow time Avito history requests began returning HTTP 402,
  `AVITO_MESSENGER_ACCESS_PAYMENT_REQUIRED`. An actual outbound request failed
  with the same status at 20:00:07. A read-only probe from the production server
  confirmed that chat listing still works while message history remains denied.
  The exact account/subscription cause requires Avito support; it is not inferred
  from the status alone. Changing the LLM provider cannot lift this restriction.
- Separately, at 08:47:58 an AI `SEND_REPLY` with empty text reached the Avito
  transport and failed validation. The response schema permits an empty default;
  the policy validator previously did not distinguish that malformed reply from
  an intentional `NO_REPLY`. This was a software defect.
- Our release checks covered service uptime, SQLite and synthetic Qwen requests,
  but not continued Avito history/delivery health. Both application services
  remained active without restarts, and `/api/readiness` incorrectly returned
  HTTP 200 during the outage. No independent operational alert was installed.
  This monitoring gap was our engineering/operational mistake.

At the initial audit snapshot, the day's inbound events were persisted and marked
processed; two AI deliveries were FAILED (one empty reply and one HTTP 402).
Seven manually authored messages were present. These counts do not establish
that every unanswered customer message was visible through the restricted API.
No customer text, names, phone numbers or credentials are included in this report.

## Fix

- Validate nonempty `SEND_REPLY` before delivery, using the existing model repair
  mechanism. Preserve legitimate `NO_REPLY`. The workflow independently rejects
  empty model text and checks its final fallback before persisting an outbound.
- Add durable component observations in SQLite: polling, Messenger history,
  outbound delivery and application HTTP. Add honest business readiness and an
  operational section to the authorized Telegram `/status` command.
- On known account-wide 402/401, persist authenticated inbound previews as CRM
  leads/conversations/messages and keep accepted events RECEIVED without spending
  processing attempts or LLM tokens. Skip follow-up generation while blocked.
  Continue read probes with a 60-second failure interval; healthy polling retains
  its existing interval. A chat-specific 403 does not block every conversation.
- Resume queued work after a successful Messenger read. A later persisted human
  reply suppresses the old AI outbound. Do not resurrect previously PROCESSED
  failed deliveries or replay the historical conversations handled manually.
- Install a separate systemd timer/oneshot watchdog, independent of the polling
  process. Detect missing/stale polling, denied access, processing failures,
  unresolved delivery/queue backlog and application HTTP failure. Notify active
  authorized Telegram recipients, with an atomic alert lease, repeat throttling
  and a recovery notification. Deliberately cancelled follow-ups do not count as
  unresolved delivery failures. Notifications contain operational codes/counts,
  never customer transcripts or credentials. No LLM calls are used by monitoring.

Relevant code: `generate-natural-response.ts`, `process-incoming-event.ts`,
`avito-runtime-safety.ts`, `poll-avito-messages.ts`, `operational-health.ts`,
`production-watchdog.ts`, `operational-health-repository.ts`,
`scripts/watch-production.ts`, and `ops/avito-watchdog.*`.
Migration `0013_operational_health` is additive; the previous application remains
compatible with the new table. No model, business policy, credentials, AWG or
Anthropic network settings are changed.

## Regression and release checks

The empty-response regression and the readiness regression were first observed
failing before the fixes. Added permanent SQLite tests cover denied ingestion,
CRM visibility, zero processing attempts while blocked, recovery/idempotency,
human supersession, alert concurrency/retry/recovery, stale polling, chat-specific
403 isolation and intentionally cancelled follow-ups. Existing tests are retained.

Local full suite passed (567 tests before the final two operational cases);
both additional cases passed their focused run. Typecheck, lint and production
build passed. The exact release is checked again on an isolated Linux candidate.
One opt-in real Qwen trajectory, `inbound-delivery-smoke`, checks a new client's
economics question and a short referential follow-on through Test Chat Lab, with
in-memory SQLite and fake delivery. Production provider smoke is synthetic;
no test messages are sent to actual Avito clients. See the release addendum for
the actual server results and rollout manifest.

## Operations and limitations

`/api/health` is process liveness. `/api/readiness` now returns HTTP 503 when the
Avito workflow is blocked, even though the application and database are healthy.
This known external 402 is an explicitly accepted degraded rollout condition,
not a successful customer-delivery check. Unexpected database/application/check
failures stop promotion or trigger rollback.

Once Avito restores access, polling retries automatically. Inspect `/status`,
`/api/readiness`, the polling journal and the first real outbound result. A
successful read is not proof of write permission: the latter is confirmed only
by an actual successful customer delivery. While history is inaccessible,
chat-list previews expose only the last message; unseen intervening messages
cannot be reconstructed by our code.

The timer catches an application/poller failure while the host, SQLite and
Telegram remain available. It cannot notify through Telegram if the entire host,
database, network or Telegram itself is unavailable. External uptime monitoring
would be needed for independent host-level coverage. This change reduces known
failure modes and removes silent green readiness; it cannot guarantee that
third-party services will never fail.

## Rollback

Promotion saves an online consistent SQLite backup, previous build/config/revision,
watchdog unit state and `/opt/avito-partner-ai-backups/<timestamp>/operational-release.json`.
The exact manifest path is printed by the release helper. On the production server:

```sh
python3 /root/operational-release.py rollback /opt/avito-partner-ai-backups/<timestamp>/operational-release.json
```

Rollback stops the new watchdog, restores the previous build/revision/config and
restarts the application and poller. It retains the additive table and all new
customer data; never restore the old live database merely to roll back code.
Rolling back code cannot resolve Avito's external 402.
