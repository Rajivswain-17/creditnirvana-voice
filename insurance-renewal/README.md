# Bot 2 — Insurance Renewal

Second voice agent for the CreditNirvana assignment. Same API as bot 1, different
`botKey`. There is no second server and no second codebase: the guardrail code in
`src/` is shared, and this bot is defined by its prompt and its config.

## What this bot sells

| Field | Value |
|---|---|
| Vehicle | Maruti Suzuki Brezza, comprehensive |
| IDV | 900000 to 800000 |
| Standard premium | 20000 |
| Discounted premium | 15000 |
| Policy expiry | 2026-11-05 |
| Add-ons | zero depreciation, engine protect, roadside assistance |

The brief asks for the renewal to be booked "at the highest achievable value". The
prompt therefore opens at 20000 and releases 15000 only as a concession, tied to a
same-call confirmation. Never below 15000.

## The three endpoints serving this bot

| Endpoint | When Sarvam calls it | What the code enforces |
|---|---|---|
| `POST /on-start/insurance_renewal` | before the first sentence | returns the vehicle, IDV, premium and expiry variables. No auth required, no body. |
| `POST /tools/insurance_renewal/log-commitment` | when a renewal and a date are agreed | amount must be 15000 or 20000; date must be a real calendar date in YYYY-MM-DD; mode must be upi, neft, imps, card or bank_transfer; a second commitment on the same call is rejected |
| `POST /tools/insurance_renewal/escalate` | claim in progress, price dispute, senior request, abuse | creates a ticket with a four digit spoken reference and a 4 hour SLA |
| `POST /webhook/sarvam?token=…` | after hangup | transcript ingest, objection tagging, compliance findings, score |

Both tool endpoints require `Authorization: Bearer $SARVAM_TOOL_SECRET`. Tool replies
are always HTTP 200 with `{"result":"accepted"|"rejected"}` so the model cannot
improvise an apology and invent a confirmation.

## Why the money rules live in code

The prompt asks for 15000 or 20000. The model can be talked out of that. The endpoint
cannot: `amount: 18000` returns `amount_not_authorised` and the model must correct
itself. That is the guardrail the assignment calls compliance.

Same for dates: "agle hafte" is rejected with `date_unclear` until the caller names a
day and month.

## Variables

Input, 9: `customer_name`, `vehicle_make`, `vehicle_model`, `policy_expiry`,
`idv_current`, `idv_renewal`, `premium_current`, `premium_renewal`, `current_date`.

Output, 9: `call_disposition`, `committed_amount`, `commitment_date`, `payment_mode`,
`primary_objection`, `addon_pitched`, `right_party_confirmed`, `escalation_reason`,
`compliance_flag`.

Success condition in Sarvam: `call_disposition = renewal_agreed`.

## Files here

| File | Purpose |
|---|---|
| `prompt.md` | the prompt as designed, with notes |
| `prompt-for-sarvam.txt` | exactly what was pasted into Sarvam's Instructions box |
| `test-script.md` | 27 test cases and the recording script |

The numbers this bot is allowed to say, its objection taxonomy and its escalation
reasons are **not** duplicated here. They live in `config/insurance_renewal.json`,
which is the single source of truth the API reads at runtime. Duplicating them here
would let the two drift apart, and a drifting price list is exactly how an agent ends
up quoting something unauthorised.
