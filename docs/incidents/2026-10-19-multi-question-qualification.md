# Multiple questions and qualification continuity

## Evidence and cause

The October 18 conversation contained a confirmed million-ruble budget, a Moscow-oblast locality, then separate questions about income per apartment and startup investment. Only investment received a delivered answer. The income extraction was correct; a newer inbound suppressed its workflow. An earlier generated reply was cancelled by inbound and never delivered. A human subsequently supplied the missing income answer.

This incident occurred on release `096b82d`, before the October 19 geography/calculation changes. Those later instructions introduced an additional conflict: optional qualification after a calculation was discouraged even when it would naturally advance an interested customer.

Three layers contributed:

- Raw persisted history mixed delivered messages with cancelled drafts; drafts could incorrectly close the active customer turn and leave misleading conversation notes.
- Generation and review did not explicitly reconcile every request across the active burst of messages. Answering the latest request could pass review while an earlier question remained unanswered.
- Answer coverage and conversation progress were not independent review decisions; generic answer recovery disabled qualification even when the defect was a missing continuation.

## Change

`customer-visible-history.ts` projects delivered conversation history for extraction and inbound response planning. Cancelled/failed/pending outbound drafts cannot close customer requests. Legacy messages without delivery metadata remain visible; intentional draft-only operation retains pending drafts. Narrative notes associated with an undelivered latest team message are withheld, allowing reconstruction from delivered history. Persistence, suppression and outbound idempotency retain the full execution history.

`compact-contract.ts` supplies a shared complete-turn contract to generation and review: answer all still-relevant requests, then choose a useful permitted continuation. Facts already known, deferred topics, refusal, closing, manager-owned actions and post-handoff support remain exceptions to asking another question. Historical lead questions are not treated as a perpetual task list.

`generate-natural-response.ts` shares the deterministic conversation objective with both calls. Review separately reports omitted requests and an unjustified missing next step. These defects trigger a bounded repair preserving supported content and permitting qualification. Unsupported-claim recovery retains its existing safety restrictions. Business qualification, approved economics and contact eligibility are unchanged.

## Regression protection

Three behavioral tests were red before the fix and green afterwards:

1. Income and investment across multiple messages: preserve investment, restore income and allow a useful next step.
2. A complete answer that unnecessarily stalls an interested customer: preserve the answer and repair continuation.
3. Workflow cancellation: exclude the undelivered draft and its narrative notes from subsequent extraction/response context; retain both customer requests.

A fourth test requires explicit completeness/continuation fields from real provider reviews; missing checks cannot silently default to success.

The permanent real-model scenario `multi-question-sales-continuation` covers three turns: both financial questions, a qualified Moscow launch profile, then a telephone number. It checks qualification, no premature handoff, exactly one handoff, duplicate-inbound idempotency, and semantic quality. External deliveries use fakes and an isolated test database.

## Verification and limits

The initial full suite passed 671 tests, lint and build; the additional real-provider contract test also passed. Final checks and the live trajectory are rerun against the release candidate.

The first local live run answered both financial questions and requested a phone after qualification, but its new harness assertion incorrectly expected the legacy literal QUALIFIED instead of the actual HOT status. The assertion now verifies contact eligibility and the persisted phone request, preserving the intended behavior. This incomplete run is not counted as a passed trajectory. Final live trajectory and release evidence are recorded alongside the evaluation report.

Semantic completeness and continuation remain model judgments, with bounded repair rather than an unconditional question requirement. This is not a guarantee of flawless behavior on every phrasing. Existing financial, geographic, duplicate-delivery and handoff safeguards remain deterministic.

## October 20 live-test findings

The first server trajectory was stopped before deployment. A valid income caveat used wording outside the existing conservative financial checker; its repair unnecessarily disabled qualification. A subsequent generated answer contained corrupted foreign-script text, which the existing guard rejected without a repair attempt. Neither failure justified weakening the financial or output guard.

Two additional regression cases now protect bounded repair of these defects while retaining a permitted next step. The financial disclaimer check and platform/script rejection still apply to the repaired result. Unsupported factual-claim recovery keeps its prior restrictions. The initial server candidate is not counted as a passed live evaluation.
