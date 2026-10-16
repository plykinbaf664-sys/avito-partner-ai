# Contact collection and continuation corrections

## Root causes and changes

- `process-incoming-event.ts` previously captured callback wishes only after
  handoff, using text heuristics. A preference supplied with the first phone
  was understood conversationally but absent from the persisted manager card.
  Extraction now supplies a semantic `contactPreferences` fact on any turn;
  merge, SQLite, CRM, manager summary and Telegram preserve it. Migration
  `0017_semantic_contact_preferences.sql` adds one nullable column. Omitted
  facts retain previous values; corrections replace the current preference.
  An unattempted PENDING card is refreshed without creating a second handoff.
- The transaction previously rejected an entire reviewed response when its
  optional information need became unavailable after handoff. The supported
  `answerText` and optional move are now reconciled independently. Conversation
  generation receives no optional qualification moves for an established
  phone/handoff, while continuing to answer current substantive questions.
- Draft memory survived removal of a question, and one live response's notes
  falsely denied asking for the phone. The existing semantic review now checks
  candidate and prior memory independently. Removed moves retain faithful prior
  memory; unreliable notes are cleared without discarding a supported answer.
- One optional contact component contained two requests. Existing review now
  selects one supported, exact contiguous request; execution only accepts that
  substring or removes the optional component. No phrase routing or extra LLM
  stage was added.
- Intentional phone completion is labeled POLICY_REPLY. A genuinely discarded
  generated response now produces a safe fallback diagnostic visible in Lab.
- Corrected deterministic income fallback grammar (`Для 1 объекта`), preserving
  approved amounts and the no-guarantee disclaimer.

## Regression and verification

New regressions were observed failing before their fixes. Permanent tests cover
first-phone preferences and one handoff, preference correction of a pending
card, preservation on an omitted fact, post-handoff answer retention, memory
after question removal, unreliable candidate/prior memory, one semantic contact
request and numerical fallback grammar. Existing assertions were retained;
callback fixtures now provide the semantic fact rather than relying on the
removed production text heuristic.

- Full suite: **658 tests / 49 files PASS**, serial worker to avoid local resource
  contention. An earlier concurrent build/test run hit two existing 5s polling
  test timeouts; no test deadlines/assertions were relaxed.
- `npm run typecheck`, `npm run lint`, `npm run build`: **PASS**.
- Final recorded HUMAN/contact/post-handoff regression: **PASS**, 12 recorded
  responses, zero live calls. It reproduced the original answer replacement
  before the correction. The baseline audit remains unchanged.
- Targeted real Qwen checks: two full trajectories (phone refusal then consent;
  HUMAN plus writing preference and post-handoff question), then one two-turn
  memory check. **29 calls**, provider-estimated **$0.030656**, isolated Lab DB and
  fake channels only. No customer/Telegram messages or production writes.
  These are targeted checks, not an exhaustive final-version live suite.

Evidence and exact version/hash boundaries:
[`../evals/2026-10-16-qualified-contact-fixed.json`](../evals/2026-10-16-qualified-contact-fixed.json).
The full targeted cases used review-v10. The final memory check used review-v11;
generation-v9 and extraction-v6 were common. Only the unit-tested deterministic
income grammar changed after that last live check. Runtime source hashes record
this difference explicitly. Recorded fixtures are TEST/EVAL data only and are
not included in production model context.

## Limits

- Preferences changed after a card is already SENT remain in CRM; this change
  does not send a second notification or edit the already delivered Telegram
  card. The agent cannot promise a manager will call/write at a particular time.
- Retaining prior memory after removal is conservative: the latest raw history
  and typed facts still supply the current context. Semantic checks reduce risk
  but cannot guarantee every future model response.
- Existing bounded-thinking latency and architecture were not optimized in
  this correction. No extra review call was introduced, but the review schema
  and instructions grew slightly.

## Release status and procedure

**Deployed and verified on 16 October 2026:** production revision
`096b82de789a5a7e3bcd37c892fa7ca438102e50`. SSH became accessible after the owner
replenished the server account; uptime showed a recent boot. Earlier TCP
timeouts occurred before authentication, without a key rejection.

All technical checks passed again in an isolated Linux candidate. All 164
reviewed runtime hashes matched. One recorded HUMAN/contact/post-handoff Lab
E2E replay passed (12 recorded responses, no paid agent evaluation or real
channel sends). Read-only Avito coverage passed. Two real Qwen network probes
passed before switching; the second read 2,043 cached tokens.

The guarded helper backed up the DB/env/build, stopped old workers, applied
the additive migration and restarted services. Health/readiness are HTTP 200;
app, polling and watchdog timer are active. Thirteen subsequent polling cycles
passed, with no failed/history-error cycles. Current readiness reports no
pending, unverified, failed or unresolved delivery backlog. No new failed Avito
inbound was observed after the release. DB integrity and the new column passed.
Env bytes match the backup; provider/network configuration was unchanged.

Production telemetry confirms two successful `qwen3.8-flash` provider probes:
28 uncached input tokens each, 2,043 cache-read tokens each, outputs 75/61,
latency 3,240/2,134 ms, estimated cost 72/66 micro-USD. These are synthetic
provider probes, not customer conversation latency. Four total deployment
probes cost an estimated $0.000629. No Claude calls were recorded in the release
window. Operational alert delivery records show zero new alert recipients and
zero failures in that window. These checks establish the observed state, not a
guarantee against future external outages.

Private evidence is retained on the server in
`/root/.config/avito-partner-ai/contact-release-evidence-096b82de789a.json` and
`contact-production-verified-096b82de789a.json`. The earlier local evaluation
JSON's NOT_DEPLOYED status describes when that evidence was recorded.

Rollback to `807e8be` from an SSH session on the server:

```sh
python3 /root/operational-release.py rollback /opt/avito-partner-ai-backups/qwen-migration-20261016-152900/operational-release.json
```

The new nullable column can remain when restoring old code/build/env; do not
restore an old DB snapshot over subsequently received customer messages. The
rollback manifest above was generated and verified during this release.
