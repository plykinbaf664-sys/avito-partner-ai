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

The original candidate text and review feedback were not persisted in production
telemetry, so the exact unsupported sentence cannot be reconstructed. No claim
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
