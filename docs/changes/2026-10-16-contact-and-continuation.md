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

**Not deployed as of this report.** SSH to `200.169.177.129:22` repeatedly times
out before authentication, including an unrestricted retry. TCP 80/443 also
time out from this workstation. The selected local route is AmneziaVPN; these
facts do not establish whether the server itself, filtering or the route is
responsible. Keys remain unchanged. Current production health is unverified.

When access is restored, inspect actual production HEAD/status/health and use
the existing guarded operational release helper: isolated Linux candidate,
server technical checks, recorded fake-channel E2E, read-only Avito coverage,
reviewed evidence, backup and rollback point, stopped-worker check, additive
migration before restart, health/readiness, real production Qwen provider smoke
and polling verification. No blind `git pull` plus service restart. Existing
env, credentials, Qwen provider and selective networking are unchanged.

Rollback must use the **new release's** generated manifest:

```sh
python3 /root/operational-release.py rollback /absolute/new-backup/operational-release.json
```

The new nullable column can remain when restoring old code/build/env; do not
restore an old DB snapshot over subsequently received customer messages. The
exact rollback manifest is unknown until a server release is actually prepared.
