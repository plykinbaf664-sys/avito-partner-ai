# Missing reply and geographic responsibility

## Production evidence

Read-only inspection confirmed the requested Avito conversation and reconstructed these events (UTC, October 20):

- 07:09: AI introduced an unsolicited geographic checking task after a city contribution.
- 07:10 and 07:13: customer asked who should check. Generation/recovery fell back after `RESPONSE_POLICY_UNSUPPORTED_ANSWER` and `RESPONSE_POLICY_UNREQUESTED_MANAGER_REFERRAL`; delivered fallbacks repeated business/catalog information instead of answering responsibility.
- 08:25: customer asked for process, prices and income in a burst of messages.
- 08:28: generation rejected a corrupted/unapproved-script response; repair failed the income-disclaimer check. The deterministic fallback concatenated approved KB entries into 1108 characters. Avito's local adapter rejected it before sending: `AVITO_INVALID_MESSAGE_TEXT` (limit 1000).
- 08:30: watchdog sent one real delivery-failure incident to two recipients. Later checks were throttled. Polling/messenger API remained healthy during inspection; this was not a fresh network outage.
- A subsequent human-manager message requested the customer's number. No old reply was resent over that message. Polling ingested the manager activity and unresolved delivery backlog returned to zero.

## Root causes and changes

The normal generated reply had a combined-size check, but its generic repair could drop qualification. The emergency KB fallback had no transport size bound at all.

`bounded-approved-reply.ts` keeps unchanged drafts when they fit, substitutes authored concise equivalents for oversized approved KB combinations, and preserves whole facts/caveats instead of cutting arbitrary text. Extreme combinations that still cannot fit explicitly disclose partial coverage. The reported process/price/income combination fits fully. Generated-length repair now preserves request coverage and permitted continuation.

The old manager-referral regex confused an explanation of company responsibility with an unsolicited handoff. Segmented responses now receive the existing mandatory semantic/source review for that distinction; legacy unreviewed text remains conservative. A new approved KB fact assigns geographic confirmation to the company, while explicitly withholding claims that a check, call or handoff already happened.

Generation and review share the same geographic contract: simply accept a city contribution; do not expose membership in internal lists or hand a checking task to the customer. Answer actual availability questions honestly, and answer responsibility questions directly. Qualification/phone/handoff eligibility and serviceability rules are unchanged.

## Regression and live verification

Three failing regression cases were added before fixes: oversized KB fallback, combined-length repair preserving continuation, and company-responsibility explanation incorrectly treated as referral. Existing assertions were preserved; a concise KB variant retained its calculation when an earlier regression exposed missing content.

The permanent isolated live scenario `geography-owner-process-contact` covers a city contribution, the responsibility/process/price/income question, a qualified supported-city profile and phone, then checks one handoff and duplicate-inbound idempotency. External channels are fakes. Final check and rollout evidence is recorded in the accompanying evaluation report.
