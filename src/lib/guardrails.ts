import { type BotConfig } from "../config.js";
import { formatDateHuman, istHour, parseFlexibleDate, weekday, daysBetween } from "./dates.js";
import { formatINR, parseAmount } from "./money.js";

/**
 * The part of the system that says no.
 *
 * A prompt is a suggestion. This is the control. When the model calls
 * log_commitment with 430000, the answer is a 200 with "rejected" and a line
 * telling it what to do instead, because a 500 makes it apologise to the caller
 * and try again, which is worse than a clean refusal.
 */

export interface CommitmentRequest {
  amount?: unknown;
  date?: unknown;
  mode?: unknown;
  reference?: unknown;
  right_party_confirmed?: unknown;
}

export interface CommitmentContext {
  config: BotConfig;
  today: string;
  existingCommitment: boolean;
  rightPartyConfirmed: boolean;
  /**
   * Per-borrower figures, when the caller is matched to a loan record.
   * One customer is at 4L/6.5L; the next is at 2.8L/4.9L. The global config
   * is only the fallback for a number we do not recognise.
   */
  allowedAmounts?: number[];
  offerValidTill?: string;
}

export type CommitmentDecision =
  | {
      ok: true;
      value: { amount: number; date: string; mode: string; reference: string };
    }
  | {
      ok: false;
      code: string;
      /** Instruction for the model. Short and imperative. */
      agentInstruction: string;
      /** A line the model may say verbatim. */
      speak: string;
    };

const MODE_ALIASES: Record<string, string> = {
  upi: "upi",
  gpay: "upi",
  "google pay": "upi",
  phonepe: "upi",
  paytm: "upi",
  neft: "neft",
  imps: "imps",
  rtgs: "imps",
  "bank transfer": "bank_transfer",
  bank: "bank_transfer",
  bank_transfer: "bank_transfer",
  "net banking": "bank_transfer",
  netbanking: "bank_transfer",
  card: "card",
  cheque: "cheque",
  check: "cheque",
};

export function validateCommitment(
  request: CommitmentRequest,
  ctx: CommitmentContext,
): CommitmentDecision {
  const { config, today, existingCommitment, rightPartyConfirmed } = ctx;
  const policy = config.commitmentPolicy;

  if (existingCommitment && policy.onePerCall) {
    return {
      ok: false,
      code: "duplicate_commitment",
      agentInstruction:
        "A commitment is already recorded for this call. Do not change it. Confirm the existing date and amount once, then close.",
      speak: "Ji, aapki baat note ho gayi hai. Main confirm karke rakhta hoon.",
    };
  }

  if (policy.requireRightParty && !rightPartyConfirmed) {
    return {
      ok: false,
      code: "right_party_unconfirmed",
      agentInstruction:
        "Identity is not confirmed. Do not accept any commitment. First confirm you are speaking to the borrower by name.",
      speak: "Sir, pehle main confirm kar loon ki main sahi person se baat kar raha hoon.",
    };
  }

  const amount = parseAmount(request.amount);
  if (amount === null) {
    return {
      ok: false,
      code: "amount_missing",
      agentInstruction:
        "No usable amount was supplied. Ask the caller exactly how much they will pay, then call again with a number.",
      speak: "Sir, exact amount bata dijiye, kitna pay kar payenge?",
    };
  }

  const allowedAmounts =
    ctx.allowedAmounts && ctx.allowedAmounts.length > 0
      ? ctx.allowedAmounts
      : config.allowedCommitmentAmounts;

  if (!allowedAmounts.includes(amount)) {
    const allowed = allowedAmounts.map(formatINR).join(" ya ");
    return {
      ok: false,
      code: "amount_not_authorised",
      agentInstruction:
        `Amount ${amount} is not authorised. Nothing was recorded. The only acceptable figures are ${allowed}. ` +
        "Do not confirm the caller's figure. Restate the two valid options and ask which one they will pay.",
      speak: `Sir, ${formatINR(amount)} par settlement approve nahi hai. Sirf ${allowed} mein se ek hi option valid hai.`,
    };
  }

  const date = parseFlexibleDate(request.date);
  if (!date) {
    return {
      ok: false,
      code: "date_unclear",
      agentInstruction:
        "The date was not a specific calendar date. Do not guess and do not convert relative phrases like 'agle shukravar'. " +
        "Ask for the day and month explicitly, then call again with YYYY-MM-DD.",
      speak: "Sir, exact date bata dijiye — kaunsi tareekh, kaunsa mahina.",
    };
  }

  if (daysBetween(today, date) < policy.minDaysFromToday) {
    return {
      ok: false,
      code: "date_in_past",
      agentInstruction: `The date ${date} is in the past. Ask again for a future date.`,
      speak: "Sir, yeh date nikal gayi hai. Aage ki koi tareekh bataiye.",
    };
  }

  const offerValidTill = ctx.offerValidTill ?? config.money.offerValidTill;
  if (offerValidTill && daysBetween(offerValidTill, date) > policy.maxDaysAfterOffer) {
    return {
      ok: false,
      code: "date_after_offer",
      agentInstruction:
        `The offer is valid only till ${formatDateHuman(offerValidTill)}. A date of ${formatDateHuman(date)} is outside it. ` +
        "Ask the caller to commit on or before that date, or explain that the case then goes back to full recovery.",
      speak: `Sir, offer ${formatDateHuman(offerValidTill)} tak hi valid hai. Usse pehle ki date dijiye.`,
    };
  }

  if (!policy.sundaysAllowed && weekday(date) === 0) {
    return {
      ok: false,
      code: "date_sunday",
      agentInstruction:
        "The date is a Sunday. Payment confirmations do not settle on Sunday. Ask for the nearest weekday.",
      speak: "Sir, Sunday ko payment confirm nahi hota. Somvar ya uske pehle ki date bata dijiye.",
    };
  }

  const modeRaw = typeof request.mode === "string" ? request.mode.trim().toLowerCase() : "";
  const mode = MODE_ALIASES[modeRaw];
  if (!mode || !config.paymentModes.includes(mode)) {
    return {
      ok: false,
      code: "mode_invalid",
      agentInstruction:
        `Payment mode "${modeRaw || "empty"}" is not accepted. Valid modes: ${config.paymentModes.join(", ")}. ` +
        "Ask how they will pay and call again.",
      speak: "Sir, payment kaise karenge — UPI, NEFT ya bank transfer?",
    };
  }

  const reference =
    typeof request.reference === "string" && request.reference.trim()
      ? request.reference.trim().slice(0, 120)
      : "";

  return {
    ok: true,
    value: { amount, date, mode, reference },
  };
}

/** RBI recovery window: calls only between the configured hours, IST. */
export function checkCallWindow(
  config: BotConfig,
  now: Date = new Date(),
): { ok: true } | { ok: false; code: string; detail: string } {
  const hour = istHour(now);
  const { startHour, endHour } = config.callWindow;
  if (hour < startHour || hour >= endHour) {
    return {
      ok: false,
      code: "outside_call_window",
      detail: `Call at ${hour}:00 IST is outside the permitted ${startHour}:00-${endHour}:00 window.`,
    };
  }
  return { ok: true };
}

/**
 * Escalation reasons are free text from the model. Snap them to the taxonomy
 * so a dashboard can group them, instead of counting 40 spellings of "legal".
 */
export function normalizeEscalationReason(reason: unknown, config: BotConfig): string {
  const text = typeof reason === "string" ? reason.toLowerCase() : "";
  const rules: Array<[string, RegExp]> = [
    ["caller_threatened_legal_action", /legal|court|police|fir|lawyer|vakil|complaint|consumer/],
    ["self_harm_risk", /suicide|jaan|marna|self.?harm|end my life/],
    ["hardship_medical", /hospital|medical|bimari|ilaj|accident/],
    ["amount_dispute", /dispute|galat|wrong amount|already paid/],
    ["abusive_caller", /abus|gaali|threat.*agent/],
    ["identity_unverified", /identity|verify|wrong person|third party/],
    ["claim_in_progress", /claim/],
    ["price_dispute", /price|premium|costly|mehnga/],
    ["wrong_party", /wrong number|galat number/],
    ["caller_requested_senior", /senior|manager|supervisor|escalat/],
  ];

  for (const [type, pattern] of rules) {
    if (pattern.test(text) && config.escalation.reasons.includes(type)) return type;
  }
  return config.escalation.reasons[0] ?? "caller_requested_senior";
}
