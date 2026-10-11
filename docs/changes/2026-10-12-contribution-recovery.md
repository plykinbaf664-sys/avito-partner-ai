# Contextual contributions and semantic recovery

## Incident and evidence

On 2026-10-11 at 21:15 MSK a customer answered a HUMAN manager's city question. Extraction correctly persisted Moscow but also returned `requiresSubstantiveAnswer=true`, `questionKind=NONE`, `previousQuestionResponse=ANSWERED`, and no questions. Five successful Qwen API calls ended in a customer-facing technical fallback. Generation was rejected with `RESPONSE_POLICY_UNSUPPORTED_ANSWER`; answer-only recovery was rejected with `RESPONSE_POLICY_UNANSWERED_CURRENT_REQUEST`. Delivery itself succeeded.

The rejected production drafts and reviewer feedback were not retained. The precise business claim behind the first rejection cannot be reconstructed; it is not established that this first rejection was incorrect.

## Root cause

An auxiliary extraction interpretation could impose a mandatory grounded answer on a simple contribution. Mechanical checks rejected valid conversational actions before independent semantic review. Any failed substantive generation then entered answer-only recovery, removing all qualification opportunities even when the actual turn merely supplied a requested fact. The reviewer had no explicit turn classification available to choose a different recovery mode.

## Changes

- The conversation brain explicitly treats requires-answer and grounding flags as advisory and interprets the actual USER/AI/MANAGER exchange.
- Existing semantic review returns `currentTurnKind` (`REQUEST`, `CONTRIBUTION`, `CLOSING`). These are LLM interpretations, not phrase routing or a scripted conversation sequence.
- Structured, semantically reviewed replies defer action-label, generic-acknowledgment and retrieval-ID intent checks to that review. Financial, business/action support, source IDs, qualification eligibility, repetition, phone and external-action boundaries still apply. Legacy unsegmented responses retain their previous checks.
- A reviewer-confirmed request uses answer-only recovery, including when extraction missed the request. A contribution uses contextual recovery with the original allowed opportunities, the rejected draft and specific feedback. Both paths remain bounded to one generation repair and recheck the delivered result.
- The compact extraction contract distinguishes answers/facts from independent requests. Prompt versions are extraction compact v4, conversation compact v7 / full v8, review context v8 / opening v2.
- Fallback diagnostics include only the semantic turn category, without drafts, prompts, customer details or reasoning.
- No added LLM call, provider change, model change, database migration or network change.

## Permanent regressions

`contribution-recovery.test.ts`:

1. Wrong mandatory-answer flag cannot veto a reviewed useful continuation.
2. Rejected unsupported business prose cannot prohibit the next useful move on a fact reply.
3. A real contextual time question still receives an answer-only repair when extraction misses it.

The first two tests were observed failing against the pre-fix implementation. Test Chat Lab additionally runs a HUMAN city question, city response with a deliberately incorrect extraction flag, and a subsequent contextual economics question through the actual application pipeline and SQLite with fake channels. No existing behavioral assertions were removed or weakened; two prompt-version assertions were updated.

## Agent evidence

One opt-in synthetic live Qwen Test Chat Lab trajectory, two customer messages:

1. HUMAN asks city; customer supplies it; AI accepts it and chooses one new topic.
2. Customer asks the cost of one object; AI uses Moscow context and explains the 180,000 RUB calculator estimate with components and uncertainty.

Both replies came from the LLM, no generation fallback, repeated city question or premature handoff. Manual review PASS. Six successful Qwen calls, no repairs, estimated cost USD 0.006416. Cache reads on extraction/review in the second turn were 3,771 / 3,444 tokens. Recorded replay PASS with zero API calls. The private synthetic report is kept outside Git.

`scripts/eval-contribution-recovery.ts` supports explicit `--live --report <private-file>` or `--replay <private-file>`; persistence is in memory, Avito and Telegram are fake, and customer data are synthetic. Reports require manual semantic review before release.

## Limits and release

Semantic classification is still model judgment, not a guarantee of perfect conversation. If review is unavailable or lacks the new category, recovery stays conservative. The existing final failure fallback is preserved, including its regression contract; this release prevents the demonstrated false mandatory-answer/recovery path rather than bypassing business safety to guarantee a reply.

Release uses an isolated Linux candidate, complete checks, recorded new and prior trajectories, a fresh backup, guarded promotion with automatic rollback on critical failure, production Qwen provider smoke, readiness and polling checks. Production rollout results and rollback manifest are recorded in the release evidence outside the repository.
