# Financial scale recovery

## Confirmed incident

A confirmed capital of 1,200,000 RUB was evaluated against an older ten-object
starting target in Moscow (1,350,000 RUB). The current turn requested a six-object
calculation (830,000 RUB). The rejection fallback combined the current calculation
with the older qualification verdict and claimed that 1,200,000 was insufficient
for 830,000. The contextual fallback also always selected one object, independently
of the current calculation's units. These were deterministic architecture defects;
changing the model alone did not fix them.

## Policy and conversation fix

- `assessFinancialReadiness`: distinguish inability to fund even one approved
  object from `DESIRED_SCALE_EXCEEDS_CAPITAL`. An unaffordable desired scale is
  negotiable and remains `BORDERLINE`, not a global `NO_FIT`.
- `evaluateQualification`: expose `STARTING_SCALE_EXCEEDS_CAPITAL` as a financial
  risk. Do not hand off an unresolved chosen scale automatically. Genuine absence
  of minimum capital, explicit expense refusal, business-model rejection and the
  remaining qualification requirements retain their safety checks.
- `buildConversationResponse`: rejection explanations use the same confirmed
  capital and minimum launch evidence as the hard blocking financial policy.
  Contextual calculation fallback uses explicitly extracted current calculation
  units. It never substitutes a hypothetical calculation for the chosen profile.
- Conversation brain and semantic reviewer receive identical structured evidence:
  minimum launch, desired launch, requested calculation and their capital
  shortfalls. All prices and comparisons originate in the approved calculator.
  Prompt versions are bumped for traceability. No new LLM stage is introduced.
- Explicit user selection can replace the older starting target and recover
  qualification. Calculation-only requests leave the chosen target unchanged.

No phrase-specific production recognition, new model fallback or networking
change is introduced. Regression examples exist only in tests/evaluations.

## Permanent regression memory

The new financial-readiness, qualification and workflow regressions first failed
on the old behavior. They cover 1.2m / target ten / calculation six, minimum-capital
rejection, preservation of the chosen target during hypothetical calculations and
recovery after explicit selection. A generator test checks identical scale-specific
evidence in both model payloads and unchanged normal call count.

`financial-scale-recovery` in `scripts/eval-conversation.ts` is a two-turn real
Test Chat Lab evaluation with an isolated database and fake deliveries. It replays
the short contextual scale response and explicit six-object selection plus phone;
it requires real LLM replies without fallback, preserved capital and one handoff.

Initial local verification: 549 tests in 43 files, typecheck, lint and build passed. Linux candidate
checks, live Qwen trajectory review and production rollout are separate release
gates, not inferred from these local results.

The first live Qwen replay was blocked before deployment: a correct calculation
was rejected because source IDs had an `approvedFacts:` namespace, followed by an
invalid optional question taxonomy label during repair. A further regression
protects technical normalization: only exact known namespaced IDs are canonicalized;
unknown IDs remain rejected. Invalid optional interpretation annotations are
discarded only for segmented answers that then require independent semantic review.
They do not select a replacement human intent. The schema lists permitted source
IDs explicitly. Adjacent scale totals are supplied by the calculator for natural
comparisons, without committing either alternative to lead facts. Compact extraction
explicitly distinguishes an ambiguous range from a chosen single starting scale.
After this correction, 552 local tests in 43 files, typecheck, lint and build passed.
The second live replay identified another missing comparison capability: the model
could compare adjacent startup totals but the corresponding approved income total
for the second option was absent from grounding. Adjacent options now carry both
deterministic startup totals and non-guaranteed income estimates. This deficiency
also has a failing-then-passing unit regression; the monetary guard stays intact.
The guard also accepts the very same desired/minimum financial evidence sent to
the brain, so a truthful comparison of a current six-object calculation with the
older ten-object target is not falsely rejected. Adjacent options include the
remaining capital and shortfall computed in code. Final local verification:
553 tests in 43 files, typecheck, lint and build passed.

## Incident repair constraints

The third live replay passed its financial turn but stopped at handoff. The
generation contract knew the manager's established name while the reviewer did
not, so it rejected that identity. Its repair used `NONE` and skipped semantic
review, where repeated prior source tags then blocked a useful acknowledgement.
Team identity is now supplied identically to generation and review; an authorized
segmented handoff always receives semantic support/action review, including repair.
Callback deadlines and other promises remain unsupported without agreement.
Both new regression tests failed before the fix and passed after it.

The fourth live replay showed that extraction can correctly retain uncertainty
without supplying calculation units. The brain understood the five/six alternatives
from history, but grounding only had the older ten-object calculation. The approved
calculator now provides a bounded preview of affordable scales independently of
that auxiliary annotation: at most twelve options, without capping explicit larger
calculations or the actual affordable maximum. Startup, income and reserve remain
deterministic. Another failing-then-passing regression protects brain understanding
with absent calculation units. The preview does not mutate chosen lead facts.

A manually authorized recovery card must distinguish confirmed capital from the
older stored scale, the subsequently discussed range and missing business facts.
It must not claim completed qualification or create a fabricated automatic handoff.
Do not infer a precise chosen scale from an ambiguous range, change historical
messages or send an unsolicited Avito response. Production corrections require
a backup and must preserve the existing phone and other business facts.

## Remaining limits

Live prices/deposit terms remain unknown; financial amounts are approved estimates.
The model still interprets semantic corrections; the new hard policy prevents a
stale scale from becoming a global financial refusal but does not invent agreement
to a smaller launch. The separately observed ambiguity between total capital and
entry-only capital remains a distinct open evaluation issue.
