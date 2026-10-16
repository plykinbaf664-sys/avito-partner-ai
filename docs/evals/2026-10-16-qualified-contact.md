# Qualified contact collection — focused live evaluation

## Scope

Local checkout `807e8be`, real `qwen3.8-flash`, production conversation pipeline
through Test Chat Lab, isolated in-memory SQLite and fake outbound/manager
channels. No customer messages, production changes or automatic deployment.
The locally configured model uses bounded thinking (2048 tokens) and explicit
cache mode. Production configuration could not be independently reconfirmed:
the read-only SSH configuration probe timed out. These are local pipeline
results, not proof of current production availability.

Runner: `scripts/eval-qualified-contact.ts`. Five synthetic trajectories cover
readiness followed by a side question, temporary phone refusal, early phone
correction, NO_FIT recovery and human-manager contact preferences. No profiles
are pre-seeded as qualified: real extraction and deterministic policy establish
readiness from the customer turns. Synthetic phone values are never sent to
real channels. The live run has a $0.15 estimated-cost threshold and 90-call
ceiling, and stops on provider errors/unmetered success.

Automatic invariants cover business readiness, normalized/corrected phone,
handoff count and phone in the handoff card, technical fallback and duplicate
inbound side effects. Manual review separately assesses conversational quality,
contact requests, preferences and memory; successful fake delivery alone is
not a semantic PASS or an estimate of real customer conversion.

## Confirmed findings

### Two requests inside one contact component

In `ready-side-question`, the first generation put both a permission question
and an imperative request into `qualificationQuestion`:

> Удобно будет, если я передам ваш контакт Дмитрию? Напишите номер телефона,
> и он свяжется с вами для обсуждения следующего шага.

Semantic review returned `optionalQuestionAppropriate=true`; both requests
were delivered. Qualification, phone capture and exactly one handoff worked.
The defect is conversational redundancy, not failed delivery.

`src/application/conversation/generate-natural-response.ts` defines a separate
optional question and reviews its appropriateness, but this observed review
did not enforce one semantic request within that component. A correction
should enforce this invariant in the existing semantic review, without phrase
blacklists or an additional model call.

### Draft question survives in memory after being removed from the reply

In `phone-refusal-then-consent`, the reply correctly answered the guest/booking
question without asking about experience. Persisted conversational notes still
said `Спрашиваю про опыт`. The question-removal branch constructs `answerOnly`
by spreading `parsed` and clearing the question, while retaining its original
`conversationMemory`. That memory is returned to persistence unchanged.

See `generate-natural-response.ts`, the
`!review.optionalQuestionAppropriate` branch and final return of
`parsed.conversationMemory`. This is a confirmed mismatch between delivered
history and auxiliary memory. Its effect on later turns is a risk; the tested
later phone turn still succeeded. Memory should represent completed moves,
not requests removed from an untrusted draft.

### Contact time given with first phone is absent from handoff card

The customer supplied a phone and `Звонить удобно после 18`. The agent replied
that it had accepted the number and convenient time, but the notification
summary contained neither the time nor the preference. Its `questions`
contained only the earlier questions about guests/bookings, and
`recommendedNextStep` was generic.

Root cause: `src/application/workflows/process-incoming-event.ts` captures
`callbackPreference` only when `currentLead.handoffAt !== null`, additionally
gated by textual slot/question heuristics. The first phone arrives before that
condition holds. `src/domain/handoff/manager-summary.ts` constructs the card
from typed lead fields; conversational notes are not included. Contact time
and channel preference should be semantically extracted on any relevant turn,
persisted independently of handoff state and included before creating the card.
Expanding phrase/regex coverage would retain the architectural cause.

The human-manager scenario also lost the customer's stronger restriction,
`сначала напишите, звонить сейчас не надо`. The card retained only an earlier
question `А без звонка можно?`, not the actual instruction. Nevertheless the
reply promised `Дмитрий напишет первым в переписку — без звонка`. Understanding
the instruction in the conversation does not ensure manager-facing persistence.

### Accepted substantive answer discarded after handoff

After that handoff the customer asked whether income from one apartment was
guaranteed. Extraction correctly treated this as a question, not a demand for
guaranteed income; qualification remained HOT. Generation produced a clear
answer denying a guarantee, plus an optional question about future scale.
Semantic review accepted both components.

In `process-incoming-event.ts`, `transactionNextInformationNeed` becomes null
when `transactionDecision.nextAction !== "CONTINUE_QUALIFICATION"`. Because the
accepted model result had `SCALING_POTENTIAL_UNITS`, the strict equality in
`canUseAdaptiveResponse` rejected the whole result. The delivered fallback
said `Для 1 объект ...`, despite three successful model calls on this inbound.

The optional move should be reconciled separately from the supported answer;
its rejection must not erase an answer to the current request. The generator
should also receive the correct post-handoff authority. Lab diagnostics exposed
`FALLBACK_DRAFT` but `responseFailureCode=null`, so testing only the latter
misses this failure. The permanent scenario now requires LLM source for
substantive question turns; a targeted recorded replay detects the regression
without any further paid calls.

### Response-source labeling caveat

The phone-only completion in `no-fit-recovery-contact` delivered the correct
handoff confirmation and one optional callback-time question, with no extra
generation/review API calls. Its source is recorded as `FALLBACK_DRAFT`, while
`responseFailureCode` is null. This is the intentional
`!phoneFulfillsRecentStep` generation bypass in `process-incoming-event.ts`,
followed by the source-classification branch, not a failed Qwen request.
Do not report every customer reply as LLM-generated or count this as an API
failure. The evaluation separately retains source and failure diagnostics.

## Reproduction

```powershell
$report = Join-Path $env:TEMP 'avito-contact-eval-20261016.json'
node --env-file-if-exists=.env.local --import tsx scripts/eval-qualified-contact.ts --live --report $report --max-cost-usd 0.15
```

The report contains only synthetic conversations and usage; credentials and
request headers are excluded. Preserve the original report before rerunning.
`--scenario ID` allows a single targeted regression; `--replay REPORT --report
NEW_REPORT` reuses recorded responses without paid model calls.

## Technical checks

- 98 qualification/financial-readiness/phone/incoming-workflow/Lab tests: PASS.
- 101 natural-response generation tests: PASS.
- Runner typecheck and ESLint: PASS.

## Final results

| Trajectory | Capture / one handoff | Quality review |
| --- | --- | --- |
| Ready lead asks a financial side question | PASS | WARN: duplicate contact solicitation |
| Refuses phone, then consents with callback time | PASS | FAIL: time missing from card; stale draft memory |
| Early phone, corrected before qualification | PASS | PASS: corrected phone in card, no premature handoff |
| NO_FIT corrected to 1.2 million / six units | PASS | PASS: 830,000 startup; duplicate inbound has no effects |
| Human manager, writing preference, post-handoff question | PASS | FAIL: preference missing; accepted answer replaced |

17 distinct customer turns, one duplicate inbound and one human-manager turn.
Five phones captured and five cards generated, each exactly once, with matching
phone values. All 57 live Qwen API calls succeeded. Fifteen delivered replies
used LLM generation; two were `FALLBACK_DRAFT` (one intentional phone-only
bypass and one erroneous replacement of a substantive answer).

Usage: 97,204 uncached input tokens, 47,524 cache-creation input tokens,
192,020 cache-read input tokens, 67,315 output tokens. Reasoning accounts for
57,987 of the output tokens; it is not an additional token total. Estimated
cost from the existing provider instrumentation: **$0.058795**. No paid judge
or additional live retests were used.

Summed sequential API waiting time per unique inbound: median **63.825 s**,
nearest-rank p90 **100.508 s**, maximum **118.174 s**, excluding application
overhead. These measurements describe this local bounded-thinking setup, not
independently verified production latency.

The targeted new regression is **FAIL**, reproduced with zero paid calls:

```powershell
$replay = Join-Path $env:TEMP 'avito-contact-regression-replay.json'
node --import tsx scripts/eval-qualified-contact.ts --scenario human-manager-contact-preference --replay docs/evals/2026-10-16-qualified-contact-regression.json --report $replay
```

Expected current exit code: 1; violation:
`SUBSTANTIVE_ANSWER_REPLACED_BY_DRAFT`. This is retained product memory for a
future fix, not a relaxed assertion accepting the current behavior.

Prioritize preserving contact preferences in persistence/card, independently
reconciling supported answers and optional moves, aligning memory with the
delivered reply, then enforcing one semantic contact request. Optimize latency
only with targeted quality checks; these trajectories do not measure whether
real people will agree to provide a phone.

Full summarized results are in `2026-10-16-qualified-contact.json`. The companion
regression fixture contains synthetic model responses only, no credentials or
customer data. No production code was changed, committed or deployed.
