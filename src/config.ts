import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Every number the agent is allowed to say lives in config/*.json.
 *
 * The prompt does not contain "₹6,50,000" anywhere. It contains {total_outstanding},
 * and this file decides what that resolves to. Same for the guardrail that
 * rejects a 430000 commitment: it reads the same file. One edit, both sides move.
 */

export interface MoneyFacts {
  currency: "INR";
  principalDue?: number;
  interestDue?: number;
  otherCharges?: number;
  totalOutstanding: number;
  settlementOffer?: number;
  offerValidTill?: string;
  daysOverdue?: number;
  idvCurrent?: number;
  idvRenewal?: number;
  premiumCurrent?: number;
  premiumRenewal?: number;
}

export interface ObjectionRule {
  type: string;
  triggers: string[];
}

export interface EscalationPolicy {
  slaHours: number;
  reasons: string[];
}

export interface CommitmentPolicy {
  requireRightParty: boolean;
  onePerCall: boolean;
  minDaysFromToday: number;
  maxDaysAfterOffer: number;
  sundaysAllowed: boolean;
}

export interface BotConfig {
  botKey: string;
  brand: string;
  agentName: string;
  /** Default borrower name used when the caller's number is not recognised. */
  customerName: string;
  promptFile: string;
  money: MoneyFacts;
  vehicle?: { make: string; model: string; policyType: string };
  allowedCommitmentAmounts: number[];
  paymentModes: string[];
  callWindow: { startHour: number; endHour: number; timezone: string };
  objections: ObjectionRule[];
  escalation: EscalationPolicy;
  commitmentPolicy: CommitmentPolicy;
}

const cache = new Map<string, BotConfig>();

export const BOT_KEYS = ["loan_settlement", "insurance_renewal"] as const;
export type BotKey = (typeof BOT_KEYS)[number];

export function isBotKey(value: unknown): value is BotKey {
  return typeof value === "string" && (BOT_KEYS as readonly string[]).includes(value);
}

/** First valid candidate wins. Defaults to the loan agent. */
export function resolveBotKey(...candidates: unknown[]): BotKey {
  for (const candidate of candidates) {
    if (isBotKey(candidate)) return candidate;
    if (typeof candidate === "string") {
      const normalised = candidate.toLowerCase();
      if (normalised.includes("insurance")) return "insurance_renewal";
      if (normalised.includes("loan") || normalised.includes("settle")) return "loan_settlement";
    }
  }
  return "loan_settlement";
}


export function loadBotConfig(botKey: string): BotConfig {
  const cached = cache.get(botKey);
  if (cached) return cached;

  const path = resolve(process.cwd(), "config", `${botKey}.json`);
  const parsed = JSON.parse(readFileSync(path, "utf8")) as BotConfig;

  if (!parsed.money || typeof parsed.money.totalOutstanding !== "number") {
    throw new Error(`config/${botKey}.json is missing money.totalOutstanding`);
  }
  if (!Array.isArray(parsed.allowedCommitmentAmounts) || parsed.allowedCommitmentAmounts.length === 0) {
    throw new Error(`config/${botKey}.json is missing allowedCommitmentAmounts`);
  }

  cache.set(botKey, parsed);
  return parsed;
}

/**
 * Every figure that may legitimately appear in speech: totals, components,
 * settlement, IDV, premium. Anything else the agent says is unauthorised.
 */
export function allowedFacts(config: BotConfig): number[] {
  const values = Object.values(config.money).filter(
    (value): value is number => typeof value === "number" && Number.isFinite(value),
  );
  return [...new Set([...values, ...config.allowedCommitmentAmounts])].sort((a, b) => a - b);
}

/**
 * The variable contract sent to Sarvam at call start. Keys must match the
 * input variables configured on the agent, exactly.
 */
export function defaultVariables(config: BotConfig, today: string): Record<string, string> {
  const money = config.money;
  return {
    customer_name: config.customerName ?? "Rajiv",
    principal_due: String(money.principalDue ?? 0),
    interest_due: String(money.interestDue ?? 0),
    other_charges: String(money.otherCharges ?? 0),
    total_outstanding: String(money.totalOutstanding),
    settlement_offer: String(money.settlementOffer ?? 0),
    offer_valid_till: money.offerValidTill ?? "",
    days_overdue: String(money.daysOverdue ?? 0),
    current_date: today,
  };
}
