# CreditNirvana Voice Agents

Two phone agents — personal loan settlement and car insurance renewal — built on
Sarvam's voice platform, with the parts a company cannot leave to a language model
enforced in code.

Sarvam owns the conversation: telephony, speech recognition, the model, speech
synthesis, barge-in, turn-taking. That is the right tool for it.

This repository owns everything where a wrong sentence costs money:

| Concern | Where it lives |
|---|---|
| The prompt | `prompts/*.md` — versioned, reviewable, diffable |
| Every authorised number | `config/*.json` — one source of truth for prompt and validator |
| Who is calling | `POST /on-start/:bot` — hashed ANI lookup, fills the agent's variables |
| A promised payment | `POST /tools/:bot/log-commitment` — validates, or refuses |
| A legal threat | `POST /tools/:bot/escalate` — ticket, SLA, stop-selling |
| What was actually said | `POST /webhook/sarvam` — transcript → analytics → audit |

## The four guarantees

**1. Only two amounts exist.** `config/loan_settlement.json` lists ₹4,00,000 and
₹6,50,000 as committable. The prompt is told that; the validator enforces it. When
the model tried `{"amount": 430000}` on a live test call, the tool answered
*rejected, amount not authorised*. The prompt is a suggestion. This is the control.

**2. Dates are never invented.** "Agle shukravar" cannot be parsed, so it is refused
with an instruction to ask for day and month. On a real test the model turned
"next Friday" into "अगला शुक्रवार इकतीस October" — the 31st was a Saturday and the
26th was a Monday. That is how a commitment becomes a complaint.

**3. Identity before money.** The caller's number is hashed and matched against the
borrower table. A miss does not fail the call; it means the agent must verify identity
verbally, and any amount said before that is a critical audit finding.

**4. The transcript is audited, not the model's self-report.** The agent fills
`compliance_flag` itself. We ignore it and run our own rules over the text. On the
same test call the model reported `none` while the transcript contained a legal threat
that was never escalated. The audit caught it.

## Architecture

```
                    ┌──────────────────────────────┐
   caller ────────► │  Sarvam  (number, STT, LLM,  │
                    │           TTS, barge-in)     │
                    └──────────────┬───────────────┘
                                   │  tool calls, bearer secret
                                   ▼
                    ┌──────────────────────────────┐
                    │  this API (Express)          │
                    │                              │
                    │  /on-start   → variables     │
                    │  /tools/*    → validate      │
                    │  /webhook    → audit         │
                    └──────────────┬───────────────┘
                                   │
                            Postgres (or memory)
```

The prompt lives in `prompts/`, is pasted into Sarvam's Instructions field, and is
the runtime copy. The numbers inside it are variables, filled at call start from
`config/`. Editing a number means editing one JSON file, not hunting through prose.

## Layout

```
config/                 authorised facts per bot
prompts/                the instruction text, versioned
src/config.ts           loads config, exposes defaults + allowed figures
src/lib/guardrails.ts   commitment validation, call window, escalation taxonomy
src/lib/analytics.ts    talk ratio, objections, language mix, repetition
src/lib/audit.ts        compliance findings + score
src/db/                 schema, memory store, postgres store
src/routes/             on-start, tools, webhook, admin
src/scripts/seed.ts     adds a borrower to the phone lookup
```

## Run it

```bash
npm install
cp .env.example .env      # leave DATABASE_URL empty to start in memory
npm run dev
npm test                  # 17 assertions on the money and audit rules
```

With a database:

```bash
# set DATABASE_URL first
npm run db:push
npm run seed -- +919876543210 Rajiv
```

## Wiring into Sarvam

Create three API tools per agent. All use the same bearer secret.

**`load_customer`** — run timing: *when the call starts*
```
POST https://<host>/on-start/loan_settlement
```

**`log_commitment`**
```
POST https://<host>/tools/loan_settlement/log-commitment
```
Arguments:

| Name | Type | Required | Notes |
|---|---|---|---|
| `amount` | number | yes | must be 400000 or 650000 |
| `date` | string | yes | `YYYY-MM-DD` |
| `mode` | string | yes | upi / neft / imps / bank_transfer |
| `right_party_confirmed` | string | yes | `yes` only after identity check |

**`escalate_to_human`**
```
POST https://<host>/tools/loan_settlement/escalate
```
Arguments: `reason` (string).

Deployment → **Webhook URL**:
```
https://<host>/webhook/sarvam?token=<WEBHOOK_TOKEN>
```

Tool responses are always HTTP 200 with `{ result: "accepted" | "rejected", message,
speak }`. A rejection is a 200 on purpose: a 4xx makes the model apologise to the
caller and improvise, which is the failure mode we are trying to remove.

## What the audit looks for

| Finding | Severity | Trigger |
|---|---|---|
| `unauthorised_amount_spoken` | high | Any figure in speech not in `config/` |
| `legal_threat` | critical | Agent mentions police, arrest, court action, seizure |
| `false_legal_claim` | critical | Warrant / case / police complaint claimed |
| `disclosure_to_third_party` | critical | Loan or amount mentioned before identity confirmed |
| `unaddressed_legal_threat` | critical | Caller threatens legal action, no escalation logged |
| `unaddressed_self_harm` | critical | Caller mentions self-harm, no escalation logged |
| `recording_objection_ignored` | high | Objection not acknowledged within two turns |
| `commitment_without_identity` | high | Promise recorded without verified borrower |
| `outside_call_window` | high | Call outside 08:00–19:00 IST |
| `repeated_sentence` | low | Same agent turn twice in a row |
| `no_clear_close` | medium | Call over a minute, no next step |

Score starts at 100. Critical −40, high −20, medium −8, low −3. One critical finding
caps the grade at D regardless of how good the sale was.

## Metrics per call

Stored on `calls.analytics`: turn counts, word counts, talk ratio, average turn
length, language mix (Devanagari / Bengali / Latin), objection types with evidence
and turn index, amounts mentioned by each side, unauthorised amounts, repeated turns,
questions asked, dates mentioned, and the audit findings.

## Limits, stated honestly

- The phone number routes to Sarvam's agent; audio cannot be handed to this API
  turn by turn. That is why the prompt runs inside Sarvam and this service decides
  what is allowed, not what is said.
- The model can still phrase something badly. It cannot commit an unauthorised
  amount, invent a date that survives validation, or hide a legal threat from the
  audit.
- In-memory mode loses everything on restart. It exists so the API runs before a
  database is provisioned, not for production.
