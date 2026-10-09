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
- The chat-list endpoint substituted a subscription/access notice for actual
  message text while keeping a message-shaped preview. Our previous code treated
  an authenticated response as proof of authentic message content. Three inbound
  records and five supposed human messages contained this provider notice. The
  three inbound records reached UNKNOWN/NO_REPLY, hiding the real client input.
  A read-only API comparison confirmed the same notice in 99 of 151 current chat
  previews and HTTP 402 on history. This is a provenance/ingestion defect, not a
  problem to solve by prompting the model or matching Russian phrases.
- Our release checks covered service uptime, SQLite and synthetic Qwen requests,
  but not continued Avito history/delivery health. Both application services
  remained active without restarts, and `/api/readiness` incorrectly returned
  HTTP 200 during the outage. No independent operational alert was installed.
  This monitoring gap was our engineering/operational mistake.

At the initial audit snapshot, the day's inbound events were persisted and marked
processed; two AI deliveries were FAILED (one empty reply and one HTTP 402).
Seven records were labeled human messages, a label subsequently shown to include
provider notices. These counts do not establish
that every unanswered customer message was visible through the restricted API.
No customer text, names, phone numbers or credentials are included in this report.

## Fix

- Validate nonempty `SEND_REPLY` before delivery, using the existing model repair
  mechanism. Preserve legitimate `NO_REPLY`. The workflow independently rejects
  empty model text and checks its final fallback before persisting an outbound.
- Add durable component observations in SQLite: polling, Messenger history,
  outbound delivery and application HTTP. Add honest business readiness and an
  operational section to the authorized Telegram `/status` command.
- Mark actual API chat-list bodies as `CHAT_PREVIEW` and message-history bodies
  as `MESSAGE_HISTORY`. Only authoritative message content enters ingestion;
  history replaces matching previews. An unverified preview preserves chat/lead
  discovery in CRM, without storing its body as customer/manager history or
  poisoning message idempotency. The incomplete polling cursor remains pinned
  for recovery when history becomes available. Already accepted valid inputs
  remain RECEIVED without spending processing attempts or LLM tokens on known
  account-wide 402/401. Skip follow-up generation while blocked.
  Continue read probes with a 60-second failure interval; healthy polling retains
  its existing interval. A chat-specific 403 does not block every conversation.
- A readable chat later in the same sweep cannot clear an access denial observed
  earlier. Explicitly quarantined legacy preview references can acquire their
  canonical payload from verified ingestion; ordinary processed duplicates
  remain immutable.
- Empty sweeps perform a throttled read-only Messenger canary (at most once per
  minute), and readiness requires recent Messenger evidence. Known account denial
  keeps the recovery cursor pinned even between canary attempts. Recoverable
  events force history loading for their chat even if it is older than the normal
  polling window, including enough overlap to recover later human replies.
- Resume queued work after a successful Messenger read. A later persisted human
  reply suppresses the old AI outbound. Do not resurrect previously PROCESSED
  failed deliveries or replay the historical conversations handled manually.
  Retrying an older blocked inbound preserves monotonic conversation clocks,
  including the latest inbound and human outbound timestamps.
- Install a separate systemd timer/oneshot watchdog, independent of the polling
  process. Detect missing/stale polling, denied access, processing failures,
  unresolved delivery/queue backlog and application HTTP failure. Notify active
  authorized Telegram recipients, with an atomic alert lease, repeat throttling
  and a recovery notification. Deliberately cancelled follow-ups do not count as
  unresolved delivery failures. Notifications contain operational codes/counts,
  never customer transcripts or credentials. No LLM calls are used by monitoring.
  Deduplicate one blocking incident by its cause rather than changing queue sizes
  or derived polling symptoms; a new blocking cause still produces a new alert.
- Archive the eight confirmed provider-notice records before excluding them
  from conversation history. Quarantine the three affected incoming identities
  for authoritative rehydration; preserve leads, facts and the LLM usage ledger.
  Clear affected conversational notes, retaining structured memory and real raw
  history. The one-off repair was dry-run against an in-memory production copy
  with foreign-key checks. `/status` separately counts references awaiting real
  Avito content. This repair does not match customer phrases in production.
  The incident cursor is rewound to the first confirmed failing history request,
  retaining normal event/message deduplication, to recover masked chats that had
  no inbound reference as well.

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
403 isolation, intentionally cancelled follow-ups, unverified preview rejection,
legacy-reference hydration and sticky account denial across mixed chat results.
The latter preview/hydration regressions also failed before their fixes.
Existing behavioral assertions are retained; the API shape assertion additionally
checks the new provenance field.

Local full suite passed (567 tests before the final two operational cases);
both additional cases passed their focused run. Typecheck, lint and production
build passed. The exact release is checked again on an isolated Linux candidate.
One opt-in real Qwen trajectory, `inbound-delivery-smoke`, checks a new client's
economics question and a short referential follow-on through Test Chat Lab, with
in-memory SQLite and fake delivery. Production provider smoke is synthetic;
no test messages are sent to actual Avito clients. See the release addendum for
the actual server results and rollout manifest.
After ingestion-only corrections, reuse that successful live trajectory and
replay its recorded Qwen outputs through the final pipeline, checking identical
delivery, no fallback and duplicate idempotency. This avoids repeating paid
behavioral calls; prompts, extraction/generation and business policies are
unchanged between the live reference and final ingestion correction.

The first guarded promotion was automatically rolled back: the deployment check
found that the poller's already-advanced cursor skipped every chat and therefore
could not establish Messenger health or hydrate old references. The authoritative
preview repair had completed and remained archived; no live DB was restored.
Two additional polling regressions and a readiness evidence regression first
failed, then passed after adding the canary and reference-driven history scan.
This failed promotion is not reported as a successful release.

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

## Release addendum: verified production result

Final application/build revision: `1908e7187343bfdfd2abd08d4c983cdeb4d2a694`.
Promotion completed at approximately 00:02 Moscow time, 10 October 2026
(`2026-10-09T21:02Z`). All four isolated Linux candidate checks passed:
typecheck, 44 test files / 576 tests, lint and production build. The final clock
and incident-deduplication regressions were also observed RED before their fixes.

The one live Qwen two-turn Test Chat Lab trajectory produced two fake Avito
deliveries, no fallback, and no extra delivery or LLM call on duplicate input.
It covered approved startup economics and a short referential follow-on about
partner participation. Eight real Qwen calls, including the evaluator, used
11,779 uncached input tokens, 5,672 output tokens, 17,327 cache-creation tokens
and 11,276 cache-read tokens. Median call latency was 9,939 ms; p90 14,378.6 ms.
The configured-tariff estimate was USD 0.008077, not a provider invoice.
Later ingestion/operational corrections were checked with the same recorded
trajectory: seven replayed model stages, two deliveries, no fallback, duplicate
idempotency PASS, and zero additional API calls. Conversational prompts,
extraction/generation, provider and business policy code were unchanged.

Two synthetic production-server calls at approximately 23:48 Moscow time
confirmed `provider=qwen`, `model=qwen3.8-flash`, SUCCESS:

| Call | Uncached input | Output | Cache creation | Cache read | Latency |
| --- | ---: | ---: | ---: | ---: | ---: |
| 1 | 28 | 49 | 2,043 | 0 | 4,313 ms |
| 2 | 28 | 73 | 0 | 2,043 | 1,778 ms |

Combined configured-tariff estimate: USD 0.000507. The final operational-only
promotion reused this successful smoke after verifying unchanged provider/config;
it did not repeat paid calls. No Claude calls were observed in the new production
usage ledger. The final blocked polling observation generated no production LLM
calls, as intended.

Post-promotion observations:

- Application and poller active, zero restarts; watchdog timer active. The
  watchdog oneshot finishes successfully and is normally inactive between runs.
- `/api/health`: HTTP 200; SQLite integrity: `ok`.
- `/api/readiness`: HTTP 503 with explicit
  `AVITO_MESSENGER_ACCESS_PAYMENT_REQUIRED`, derived polling degradation and the
  waiting-inbound backlog. This is an unresolved external dependency failure,
  not healthy customer delivery.
- Three valid, authoritative inbound records remain RECEIVED with zero processing
  attempts. No unverified references remain. No unresolved historical outbound
  failures remain; two original FAILED delivery records are retained for audit.
- Zero remaining confirmed provider-notice messages; zero conversation timestamp
  regressions after the final monotonic-clock correction.
- The operational alert reached two active authorized Telegram recipients.
  Final watchdog observations were THROTTLED for the existing incident; changing
  secondary symptoms did not resend it. Periodic incident reminders remain enabled.

The eight original provider-notice records were archived before repair in
`/opt/avito-partner-ai-backups/qwen-migration-20261009-203649/` alongside the
original consistent database backup. No actual customer message was deleted.
The final release's separate backup and manifest are:

```text
/opt/avito-partner-ai-backups/qwen-migration-20261009-210217/operational-release.json
```

Exact rollback on the production server, to the previous working protected build
`2ca973d2300fcaa3010592efe81634b3c9192ab7`:

```sh
python3 /root/operational-release.py rollback /opt/avito-partner-ai-backups/qwen-migration-20261009-210217/operational-release.json
```

Customer delivery remains unverified and blocked by Avito HTTP 402. After support
restores access, inspect the automatic recovery and first actual SENT delivery;
do not treat a successful history read or synthetic Qwen request as proof of it.
