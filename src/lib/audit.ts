import { allowedFacts, type BotConfig } from "../config.js";
import { type CallAnalytics, type Turn } from "./analytics.js";
import { istHour } from "./dates.js";
import { formatINR } from "./money.js";

/**
 * Compliance and quality audit, run in code over the finished transcript.
 *
 * This layer exists because the model cannot be the judge of its own
 * compliance. It writes the finding, we write the rule. When the two disagree,
 * the rule wins, and the finding is in the database either way.
 */

export type Severity = "critical" | "high" | "medium" | "low";

export interface Finding {
  type: string;
  severity: Severity;
  evidence: string;
  turnIndex?: number;
}

export interface AuditInput {
  config: BotConfig;
  turns: Turn[];
  analytics: CallAnalytics;
  rightPartyConfirmed: boolean;
  escalationCount: number;
  commitment: { amount: number; date: string } | null;
  startedAt: Date | null;
  durationSeconds: number;
  disposition: string | null;
  /** Figures belonging to the matched borrower, on top of the portfolio config. */
  extraAllowedAmounts?: number[];
}

const THREAT = /\b(?:police|arrest|giraftaar|jail|jabt|seize|warrant)\b/i;
const THREAT_COURT = /\bcourt\b[^.?!]{0,40}\b(?:jaunga|jayenge|case|notice|bhej)/i;
const ABUSE =
  /\b(?:chutiya|madarchod|bhosdi|bhosdike|harami|kutta|saala|gandu|bewakoof|stupid|idiot|fool)\b/i;
const FALSE_LEGAL =
  /(?:warrant|non.?bailable|cbi|police complaint)\b[^.?!]{0,40}\b(?:issue|ho jayega|kar denge|nikal)/i;
const SENSITIVE = /\b(?:loan|outstanding|settlement|emi|due|policy|premium|idv)\b/i;
const RECORDING_ACK = /\brecord\w*\b/i;
const ACK_WORDS = /\b(?:band|stop|nahi kar|samajh|note|sirf|quality|training|compliance|legal|haan|ji)\b/i;

export function auditCall(input: AuditInput): Finding[] {
  const findings: Finding[] = [];
  const { config, turns, analytics, commitment, durationSeconds } = input;
  const agentTurns = turns.filter((turn) => turn.role === "agent");
  const callerTurns = turns.filter((turn) => turn.role === "caller");

  // 1. An amount the business never authorised.
  const facts = new Set<number>([...allowedFacts(config), ...(input.extraAllowedAmounts ?? [])]);
  const unauthorised = analytics.agent.amountsSpoken.filter((amount) => !facts.has(amount));

  if (unauthorised.length > 0) {
    const quoted = unauthorised.map(formatINR).join(", ");
    const turn = agentTurns.find((candidate) =>
      unauthorised.some((amount) => candidate.textEn.includes(amount.toLocaleString("en-IN"))),
    );
    findings.push({
      type: "unauthorised_amount_spoken",
      severity: "high",
      evidence: `Agent said ${quoted}, which is not in the authorised set.`,
      turnIndex: turn?.index,
    });
  }

  // 2. Threats and abuse by the agent.
  for (const turn of agentTurns) {
    if (THREAT.test(turn.textEn) || THREAT_COURT.test(turn.textEn)) {
      findings.push({
        type: "legal_threat",
        severity: "critical",
        evidence: clip(turn.textEn),
        turnIndex: turn.index,
      });
      break;
    }
  }

  for (const turn of agentTurns) {
    if (ABUSE.test(turn.textEn)) {
      findings.push({
        type: "abusive_language",
        severity: "critical",
        evidence: clip(turn.textEn),
        turnIndex: turn.index,
      });
      break;
    }
  }

  for (const turn of agentTurns) {
    if (FALSE_LEGAL.test(turn.textEn)) {
      findings.push({
        type: "false_legal_claim",
        severity: "critical",
        evidence: clip(turn.textEn),
        turnIndex: turn.index,
      });
      break;
    }
  }

  // 3. Talking about the debt while the borrower is not confirmed.
  if (!input.rightPartyConfirmed) {
    const leak = agentTurns.find((turn) => turn.role === "agent" && SENSITIVE.test(turn.textEn));
    if (leak) {
      findings.push({
        type: "disclosure_to_third_party",
        severity: "critical",
        evidence: clip(leak.textEn),
        turnIndex: leak.index,
      });
    }
  }

  // 4. Recording objection: acknowledged within two agent turns, or not.
  const objectionTurn = callerTurns.find((turn) =>
    /record(?:ing)? (?:mat|band|na)|why.*record|recording kyun/i.test(turn.textEn),
  );
  if (objectionTurn) {
    const later = agentTurns.filter((turn) => turn.index > objectionTurn.index).slice(0, 2);
    const acknowledged = later.some(
      (turn) => RECORDING_ACK.test(turn.textEn) && ACK_WORDS.test(turn.textEn),
    );
    if (!acknowledged) {
      findings.push({
        type: "recording_objection_ignored",
        severity: "high",
        evidence: "Caller objected to recording and the agent did not address it in the next two turns.",
        turnIndex: objectionTurn.index,
      });
    }
  }

  // 5. Caller threatened legal action and nobody was told.
  if (analytics.caller.mentionsLegal && input.escalationCount === 0) {
    findings.push({
      type: "unaddressed_legal_threat",
      severity: "critical",
      evidence: "Caller raised court/police/legal action and no escalation was recorded.",
    });
  }

  if (analytics.caller.mentionsSelfHarm && input.escalationCount === 0) {
    findings.push({
      type: "unaddressed_self_harm",
      severity: "critical",
      evidence: "Caller mentioned self-harm and no escalation was recorded.",
    });
  }

  // 6. A promise taken from someone we never verified.
  if (commitment && config.commitmentPolicy.requireRightParty && !input.rightPartyConfirmed) {
    findings.push({
      type: "commitment_without_identity",
      severity: "high",
      evidence: `Commitment of ${formatINR(commitment.amount)} taken without confirmed identity.`,
    });
  }

  // 7. The same sentence twice.
  if (analytics.agent.repeatedTurns > 0) {
    findings.push({
      type: "repeated_sentence",
      severity: "low",
      evidence: `${analytics.agent.repeatedTurns} consecutive agent turns repeated verbatim.`,
    });
  }

  // 8. A long call that ended without a next step.
  const closed = ["settlement_agreed", "full_payment_agreed", "not_interested", "wrong_person", "callback_scheduled"];
  if (durationSeconds > 60 && !commitment && !closed.includes(input.disposition ?? "")) {
    findings.push({
      type: "no_clear_close",
      severity: "medium",
      evidence: `Call ran ${durationSeconds}s and ended with disposition "${input.disposition ?? "empty"}".`,
    });
  }

  // 9. Called outside the permitted window.
  if (input.startedAt) {
    const hour = istHour(input.startedAt);
    if (hour < config.callWindow.startHour || hour >= config.callWindow.endHour) {
      findings.push({
        type: "outside_call_window",
        severity: "high",
        evidence: `Call started at ${hour}:00 IST, outside ${config.callWindow.startHour}:00-${config.callWindow.endHour}:00.`,
      });
    }
  }

  // 10. Agent doing all the talking.
  if (analytics.turnCount >= 4 && analytics.talkRatio > 0.75) {
    findings.push({
      type: "agent_dominates_call",
      severity: "low",
      evidence: `Agent spoke ${Math.round(analytics.talkRatio * 100)}% of the words.`,
    });
  }

  if (durationSeconds > 600) {
    findings.push({
      type: "call_too_long",
      severity: "low",
      evidence: `Call ran ${durationSeconds}s, above the 10 minute target.`,
    });
  }

  return findings;
}

const PENALTY: Record<Severity, number> = {
  critical: 40,
  high: 20,
  medium: 8,
  low: 3,
};

export interface Scorecard {
  total: number;
  grade: "A" | "B" | "C" | "D";
  deductions: Array<{ type: string; points: number }>;
}

/**
 * A single number a manager can sort by. Deliberately harsh: one critical
 * finding caps the call below 60 regardless of how well the sale went.
 */
export function scoreCall(findings: Finding[], analytics: CallAnalytics): Scorecard {
  let total = 100;
  const deductions: Array<{ type: string; points: number }> = [];

  for (const finding of findings) {
    const points = PENALTY[finding.severity];
    total -= points;
    deductions.push({ type: finding.type, points });
  }

  if (analytics.agent.repeatedTurns > 0) {
    total -= 5;
    deductions.push({ type: "repetition_penalty", points: 5 });
  }

  total = Math.max(0, Math.min(100, total));
  const grade = total >= 85 ? "A" : total >= 70 ? "B" : total >= 55 ? "C" : "D";

  return { total, grade, deductions };
}

function clip(text: string): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length <= 200 ? clean : `${clean.slice(0, 199)}…`;
}
