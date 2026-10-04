# Contextual next step and contact recovery — 2026-10-04

## Confirmed incident

The local Test Chat Lab trajectory was inspected read-only, including its
persisted extraction and LLM usage. The lead already had enough business facts:
Moscow, confirmed available capital, launch intent, operational readiness and
goal. Deterministic qualification was `HOT / PHONE_UNKNOWN`; unknown starting
units did not block it. The business qualification had finished, but the
conversation failed to bridge to contact and handoff.

For the final contextual question, both extraction attempts were rejected with
`INVALID_CONVERSATION_SIGNALS`. The stored extraction was degraded: it retained
the need for a substantive answer, but lost the resolved reference, question
kind and knowledge IDs. Generation was rejected with
`RESPONSE_POLICY_UNSUPPORTED_ANSWER`; its repair also failed. All five API calls
were successful Qwen calls. This was a validation/context failure, not an API
outage or missing credentials. The full turn took about 119 seconds.

The original candidate text and review feedback were not present in the incident's
persisted telemetry, so the exact unsupported sentence cannot be reconstructed. No claim
is made that a particular sentence caused that original rejection.

## General causes reproduced by regression tests

1. Contextual surface normalization required a pending CRM question and
   `intent=QUESTION`. A real follow-on question can refer to an explanation,
   have no pending field, and contain agreement as well as a new request.
   Its semantic expansion was rejected as ungrounded surface text.
2. Any recommendation discarded the separate optional question, including an
   authorized contact request after successful qualification. This conflated
   continuing a questionnaire with the bridge to execution.
3. The conversation model and semantic reviewer did not share an explicit
   contact/action authorization. Approved knowledge explains the business;
   deterministic policy separately authorizes contact and handoff. Absence of
   a contact procedure from a knowledge article cannot invalidate that policy.
4. A polite request without `?` was treated as a missing question. A real Qwen
   run reproduced the resulting unnecessary repair. The output already has an
   explicit request field; punctuation must not decide its conversational role.
5. Optional questions on plain confirmation turns bypassed semantic review,
   leaving a gap in anti-repetition protection.

## Changes

- Preserve the current surface separately from the model-resolved referent when
  actual prior conversation exists. CRM state and the coarse intent enum no
  longer gate this normalization. Unresolved/unrelated signals still undergo
  the existing bounded repair and conservative degradation.
- Pass the same structured `handoffPolicy` to generation and semantic review:
  qualification status/reasons, whether contact may be requested, whether the
  phone is already known, whether handoff already occurred, and whether transfer
  is authorized. Actual qualification and execution remain deterministic.
- Retain an allowed contact offer alongside a useful recommendation; still
  discard unrelated qualification questions. The model chooses timing and
  wording; an empty field does not mandate a question.
- Validate the explicit request component structurally and semantically.
  Legacy unsegmented output retains its existing checks. Multiple questions,
  unavailable needs, invented promises, prices and economics remain guarded.
- Review optional requests even on confirmation turns; remove an inappropriate
  optional question independently of a supported answer. Contact permission
  does not authorize invented prerequisites, meetings or callback deadlines.
- The reviewer explicitly reports an extra qualification request embedded in
  `answerText` and selects the useful exact prefix before it. Code permits only
  tail deletion from the original; generated replacements are rejected. The
  retained answer is checked against the current request and all hard policy
  checks run again before delivery. Genuine clarification of the current
  ambiguous request remains allowed. Modern real providers must return these
  segmentation fields explicitly. This reuses the existing review call.
- Version extraction, conversation and review contexts for usage attribution.
  Regression trajectories remain test/eval data and never enter production
  model context.

## Verification and rollout

New tests first demonstrated the old failures. Coverage includes a resolved
reference without a pending field, eligible contact after practical guidance,
requests with/without question punctuation, repetition on confirmation and a
real Test Chat Lab workflow through one handoff and duplicate inbound.

The first targeted real-Qwen trajectory completed four inbound turns, no
fallback and one handoff. It revealed the punctuation-related repair, which
was then covered and fixed. This first run alone is not proof of the final
version; the final server controlled E2E is the release gate. Broad exploratory
live evaluation remains deferred as requested by the owner.

The initial production candidate `53c6149` passed 534 tests, Linux build,
health/readiness and runtime Qwen smoke. Its server E2E auto-judge also passed,
but manual trajectory review found duplicate contact requests within individual
turns: the request appeared both in the answer and the optional component. This
was a critical product failure despite successful handoff. The release was
rolled back to `262bc841e65839c54e4a0122f716885df85bc2c8`; the database was not
restored over new messages. The backup manifest records the failed manual review.
That run is not counted as a product-quality PASS. The new permanent tests and
explicit segmentation output cover this additional failure class.

Subsequent releases require manual inspection of the server candidate's
controlled E2E before promotion. After promotion, runtime Qwen smoke and
health/readiness still gate the rollout, with automatic rollback on failure.
Successful trajectories are not rerun without an affected code change.

Deployment uses an isolated Linux checkout, full software checks, a consistent
SQLite backup and the previous build. No schema migration, credential change,
networking change or business qualification rule change is required. Health,
readiness, real production-runtime Qwen smoke and an isolated server E2E gate
the release; a critical failure restores the previous code/build/configuration
without restoring an old database over newly received messages.

Residual considerations: semantic review is probabilistic and adds a call on
turns with optional requests that were previously unreviewed. Avoided repair
calls can offset this, but no percentage saving is claimed without measurement.
The first targeted run had substantial LLM latency; this change does not solve
the separate inference-latency problem.

The isolated server trajectory for `64f868c` failed its handoff assertion:
Qwen interpreted the initial synthetic financial statement as ENTRY_ONLY,
with budgetConfirmed=false. Financial policy correctly withheld handoff; no
qualification assertions or rules were relaxed. Exact-prefix cleanup worked
in that run. The full-trajectory scenario remains unchanged and open; it is
not counted as PASS. A separate permanent replay starts from the incident's
confirmed qualified profile and authentic AI participation context, then runs
readiness, the contextual next-step question and phone through the real pipeline.
Its fixture independently asserts unchanged deterministic qualification and
absence of handoff authorization before the phone. This distinguishes the
reported contact/reference failure from the separate financial extraction issue.

## Final release evidence

Production application/build revision: `65b432754d89321cec78a6b91f5e87cfdc6a9d41`.
All 539 tests, typecheck, lint and build passed in the isolated Linux candidate;
the application changes also passed locally (tests with one worker).

The targeted seeded replay passed on real `qwen3.8-flash`: three inbound turns,
three LLM replies, no response failure/fallback, one manager notification. Its
duplicate inbound caused no new call or outbound. Both semantic judge and manual
inspection passed. The first generated answer included two requests, but the
semantic prefix cleanup retained exactly one before delivery. On the follow-on
question, review removed the repeated optional request while preserving the
explanation of the contact step. The phone acknowledgment required one bounded
repair; the final response remained LLM-generated and the handoff remained once.

This replay recorded 11 workflow calls plus one evaluation-judge call, no API
errors, two rejected drafts, and tariff-estimated total cost $0.010110 including
the judge. Mean call latency was 14.63 seconds; this small sample is not a
production cost/latency forecast. The unrelated unseeded financial scenario
remains failed/open as recorded above, not replaced or weakened by this replay.

The final consistent backup and rollback manifest are at:
`/opt/avito-partner-ai-backups/qwen-migration-20261004-160126/ready-contact-release.json`.
After promotion health/readiness passed, both services were active/running with
zero restarts, and the first four polling cycles completed without error events.
Two actual production-runtime smoke calls recorded provider Qwen, model
`qwen3.8-flash`, success, uncached input 28/28, output 63/58, cache creation
2043/0, cache read 0/2043, latency 2951/1854 ms. No Claude calls were recorded in
that observation window. Existing networking and credentials were unchanged.

Controlled replay used the real application pipeline on the production server
with an isolated in-memory database and fake Avito/Telegram delivery. No test
message was sent to a real customer; actual new customer delivery was not
claimed from smoke calls. Successful replay was not rerun after promotion.

Rollback on the server (previous working Qwen build/configuration; inbound DB
is preserved):

```sh
python3 /root/ready-contact-release.py rollback /opt/avito-partner-ai-backups/qwen-migration-20261004-160126/ready-contact-release.json
```
