# Queued budget question and locality continuation

## Observed production incident

The October 18 conversation described by the owner as Mila's latest chat contains
the scale of 40 apartments, a request for the required budget, and the location
Putilkovo, Moscow Oblast. Production revision was `096b82d`. Investigation was
read-only; the customer's history and business facts were not repaired or replayed
into real channels.

The question arrived at 14:17:17 UTC while the answer to the preceding scale
message was still being generated. That earlier answer was saved at 14:18:01.
Processing the queued question then used the last outbound as the active-turn
boundary. Because it followed the inbound in chronological history, both generation
and semantic review received an empty `activeUserTurn`.

The journal records `RESPONSE_POLICY_MISSING_CURRENT_INTENT_ANSWER`, followed by
`RESPONSE_POLICY_UNANSWERED_CURRENT_REQUEST` during recovery. The final outbound
was `FALLBACK_DRAFT`: the generic service description for 50,000 RUB, without the
requested total. Raw historical model drafts are not stored; the empty context
defect is demonstrated by the deterministic reproduction, not inferred model thoughts.

The fallback also had an independent defect: the correct extracted
`calculationUnits=40` did not enable the calculation draft without a contextual
reference flag. This was an explicit question, so that flag was correctly false.

After the location clarification, the model exposed internal supported-city list
language and reused only the cheaper regional example. Conversation economics
provided that single example for any known non-Moscow locality, even when the
surrounding conversation identified Moscow Oblast. A general scenario is not a
verified local rental price or a serviceability determination.

## Change

- Inbound processing passes the persisted message identity and original event text
  to generation. Generation, repair and review share the event-anchored exchange;
  later messages remain visible separately. Missing history cannot erase the event
  text. Manager suppression, concurrency checks and delivery idempotency remain in
  the execution workflow.
- An explicitly requested cost calculation can use the extractor's semantic
  knowledge selection without a contextual flag. The fallback renders the approved
  totals and assumptions, including the one-time fee. Income calculations retain
  their existing behavior. No customer-language matching was added.
- Conversation economics can include both approved comparison scenarios when the
  locality has no specific approved rent reference. The existing default calculator
  and deterministic financial qualification rules are unchanged. Generation,
  monetary validation and review use the same economics context.
- Generation and review share instructions to treat location and rent assumptions
  separately, keep internal status/list explanations out of customer replies, and
  respond naturally to a location contribution without an unsolicited recalculation.
  Prompt versions are `conversation-compact-v10`, `conversation-context-v11` and
  `review-context-v12`.
- The approved geographic article no longer mixes business availability with
  internal automatic-rejection commentary. The list itself remains available for
  actual questions about coverage. Semantic review distinguishes such a question
  from merely supplying a locality.

## Permanent regression memory

Before fixes, four new cases failed: queued-question context in both model calls,
explicit budget fallback for 40 and 17 objects, and comparison capabilities for an
unpriced locality. All four then passed. The 17-object case checks generalization
beyond the incident's number. Existing income, qualification, handoff and
conversation regressions remain intact; only a technical prompt-version assertion
was advanced.

`large-launch-locality-continuation` is a permanent live Test Chat Lab scenario:
budget for 40 apartments → manager asks location → Putilkovo → Moscow comparison.
It uses an isolated database, real configured models, fake channels and a semantic
trajectory judge. Its assertions require LLM replies, no generation fallback,
no false rejection, no premature handoff and duplicate-event idempotency.

The first live replay passed the delivered-answer checks. A later replay caught a
new unsupported inference that Moscow prices were likely closer to Putilkovo's
market. Review rejected it, then also rejected the repair's internal-list language;
the release gate stopped on fallback. This failure led to removing policy prose
from the approved geographic article and explicitly reviewing its conversational
relevance. Failed live evidence is retained rather than relabeled as a pass.
An additional fallback audit confirms that a plain location contribution can
continue without displaying the city catalogue; it does not mandate an unsolicited
availability lecture. A component regression protects retaining a supported
calculation when a separate optional question is rejected for language or relevance.

## Limits

Putilkovo is not silently added to approved business geography. Availability and
actual property terms remain subject to confirmation. Example budgets exclude an
additional operating reserve and are not market quotations. Interpretation and
wording remain model-dependent; the queued-event boundary and fallback totals are
deterministic.

## Release checks

Final local checks passed: 49 test files, 664 tests, typecheck, lint and production
build. The final live locality trajectory passed with three LLM replies, no fallback,
no false rejection and no handoff. The adjacent financial-scale recovery trajectory
also passed. Four live runs, including the retained blocked run, used 36 calls with
an estimated total cost of USD 0.053504.

Full synthetic transcripts, model judgments, traces, usage and source hashes are
in `docs/evals/2026-10-19-queued-budget.json`. These are scoped behavioral evidence,
not a claim that every future model response is correct. Server deployment evidence
is recorded below.

## Deployment and notification follow-up

Revision `291f813260a9e7531f86953886067c6475620b55` was deployed on October 19.
Linux typecheck, all 664 tests, lint and build passed. Server Test Chat Lab
`inbound-delivery-smoke` passed with two deliveries to fake channels, no handoff,
seven calls and estimated cost USD 0.008817; both answers were manually reviewed.
Evidence: `/root/.config/avito-partner-ai/operational-e2e-291f813260a9.json`.
Two production provider smoke calls succeeded. Backup/release manifest:
`/opt/avito-partner-ai-backups/qwen-migration-20261019-093126/operational-release.json`.

During observation, Avito token/account requests intermittently timed out or
returned HTTP 502. Readiness temporarily became 503, then polling and Messenger
recovered without configuration changes. At 09:40 UTC all components were OK,
readiness was 200, pending/failed inbound and unresolved outbound were zero.
Two historical failed deliveries remained unchanged.

The owner requested fewer incident/recovery notifications during this release.
Previously three transient observations could trigger Telegram before a quick
recovery. A new SQLite watchdog regression first failed on that behavior.
Transient polling/Messenger network, rate-limit and common HTTP 5xx alerts now
wait until five minutes without a known successful component observation.
Readiness is unchanged. Access blocks, stale polling, processing failures and
unresolved delivery failures remain immediately actionable. No recovery is sent
for a suppressed incident. Missing successful evidence is not suppressed.
The test also checks that a sustained outage is delivered once per recipient.

The notification-only follow-up does not change conversation behavior; its server
release may reuse the reviewed live report after verifying the application diff.
