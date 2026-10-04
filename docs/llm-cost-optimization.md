# LLM cost optimization — first release

## Contract

LLM keeps semantic intent, references, corrections and conversational decisions. Business economics, qualification, safety and execution remain deterministic. Models and semantic-review eligibility are unchanged in this release.

## Root causes

Static instructions and the approved knowledge base were sent without cache control on every API call. History/exchange and identical calculator contexts repeated data within a payload. Existing event usage columns recorded extraction only; response generation, review, follow-up and failed repair paths were not a complete cost ledger. A successful repair replaced the previous response object and dropped the first generation/review usage: the permanent regression reproduces 70 input tokens reported instead of 100 before the fix.

These are code-level findings. Their production cost shares cannot be reconstructed from the old ledger, and no savings percentage is asserted.

## Changes

- Every Anthropic API attempt is written to `llm_calls` before the network request. Completion records model, stage, attempt, event/conversation/request correlation, release, prompt/schema hashes, latency, request ID, stop reason, uncached input, output, both cache-write durations and cache reads.
- API failures keep unknown usage as NULL. A process crash leaves STARTED, rather than fabricated zero cost. Ledger failures are logged without replaying paid work.
- Successful responses that fail local validation are marked REJECTED. Workflow outcome distinguishes USED, FALLBACK, SUPPRESSED, NO_REPLY and FAILED. Workflow outcome applies to the whole attempt group; it does not mean every draft was delivered.
- Generation/review/repair usage is aggregated across every attempted call and retained through errors. Legacy incoming-event columns continue to mean extraction usage; the new ledger is authoritative for complete cost accounting.
- Production, development, Test Chat Lab and CLI eval have separate workload labels. Follow-ups have their own operation label. Eval JSONL is written per call so incomplete runs retain usage.
- Stable instructions and complete approved KB are cached per stage/schema/model with a five-minute breakpoint. Mutable lead state, history, current message and retry feedback remain after the breakpoint. Current TTL must be tuned from measured hit rate; no guaranteed saving is assumed.
- Exact duplicate exchange text becomes `sameValueAs` references to history; history roles, ordering and older raw referents are retained. Only identical calculator contexts are aliased; distinct requested-unit scopes remain independent.
- The complete current user turn reaches the brain and critic. Verified facts and conversational notes are available to both. Extraction and follow-up receive the existing notes without a separate summary call.
- Prompts, transcripts, responses, keys and raw API error bodies are not in the usage ledger/logs.

## Migration

Apply the additive Drizzle migration `0012_colossal_warstar.sql` before using the new runtime. Existing lead, conversation and incoming-event records are preserved. Older event usage is not backfilled as complete usage because generation/review tokens were never stored.

## Reports

```powershell
npm run report:llm-usage -- --database-url file:./data/local.db --workload PRODUCTION --since 2026-10-04T00:00:00Z
npm run eval:conversation -- --report C:/Temp/avito-eval.json --max-cost-usd 2
npm run report:llm-usage -- --usage-jsonl C:/Temp/avito-eval.json.usage.jsonl
npm run measure:llm-context
npm run measure:llm-context -- --count-tokens
```

The database report reads existing data without migrations or writes. It refuses to create a missing database. Reports emit aggregates only. STARTED/ERROR calls and unknown model tariffs make the price incomplete and disable full-cost projections. The inbound denominator includes only events with recorded calls; duplicate/zero-call deliveries are not included.

Context measurement uses synthetic fixtures with the real application builders, comparing payload before/after lossless factoring. It does not read customers, generate replies or write a database. Optional `--count-tokens` uses the provider's free token estimate endpoint; estimates differ from billing, and the prefix probe includes provider/schema overhead. This is not a historical production baseline or proof of cache hits. Partial eval reports explicitly set `completed: false` and preserve the abort code.

Offline measurement on 2026-10-04, serialized character counts (not tokens or dollars):

| Synthetic history | Stage | Before factoring | After factoring |
| --- | --- | ---: | ---: |
| 2 messages | Extraction | 28,439 | 28,942 |
| 2 messages | Generation | 35,999 | 33,641 |
| 2 messages | Review | 14,817 | 14,958 |
| 12 messages | Extraction | 33,225 | 33,728 |
| 12 messages | Generation | 41,229 | 38,500 |
| 12 messages | Review | 20,023 | 19,793 |

The new cache/reference instructions have overhead. Factoring alone does not reduce every payload; caching is the larger candidate saving and requires real hit-rate evidence. Keeping the whole active user turn can increase context for large inbound bursts; the current workflow loads up to 100 messages with an 8,000-character inbound limit. This release does not claim to solve that worst-case memory/burst budget. A size-aware strategy needs separate trajectory evaluation rather than silent removal of referents.

Tariffs are dated estimates, not invoices: Haiku 4.5 input/output $1/$5 per million; Sonnet 4.6 $3/$15. Five-minute writes cost 1.25x input, one-hour writes 2x, cache reads 0.1x. Unknown models stay unpriced. Eval checks accumulated known cost before starting the next call; one in-flight call can exceed the selected threshold.

## Next measurement gate

Collect representative production calls, cache hits by stage and inter-call gaps, repaired/rejected/discarded generation, burst size, cost per complete dialogue and semantic-eval outcomes. Compare candidates on the permanent trajectories before changing reviewer frequency, models, sparse extraction, burst processing or memory/history architecture. Those higher-risk changes are intentionally conditional on evidence.

## Release gate

Software verification on 2026-10-04: typecheck PASS, lint PASS, 504 tests across 40 files PASS, production build PASS. Permanent regressions cover successful/failed repair accounting, stable cache prefixes, current-request/fact/memory preservation, privacy, cache-write pricing, telemetry failures without API replay, unknown-cost reports, duplicate inbound and follow-up context. The original accumulated assertions were preserved.

Live evaluation is currently incomplete: the latest single-trajectory attempt stopped on extraction with `ANTHROPIC_HTTP_400`, category `BILLING`, and zero completed trajectories. The token-estimate endpoint also returned HTTP 400. No cache hit, live semantic pass or measured cost reduction is claimed. The owner has deferred topping up the API balance; no further provider calls are planned in this iteration. Changes remain local; production DB, services and customer channels have not been changed.

Primary references:
- https://platform.claude.com/docs/en/build-with-claude/prompt-caching
- https://platform.claude.com/docs/en/build-with-claude/structured-outputs
- https://platform.claude.com/docs/en/about-claude/pricing
