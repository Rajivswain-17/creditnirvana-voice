import { type BotConfig } from "../config.js";
import { parseFlexibleDate } from "./dates.js";
import { extractAmounts } from "./money.js";

/**
 * Post-call analytics computed from the transcript, not from the model's
 * self-report. If the agent claims it handled an objection, but the caller's
 * turns never moved, the numbers here say so.
 */

export type TurnRole = "agent" | "caller";

export interface Turn {
  index: number;
  role: TurnRole;
  textEn: string;
  textIndic?: string;
}

export interface ObjectionHit {
  type: string;
  evidence: string;
  turnIndex: number;
}

export interface CallerSignals {
  amountsMentioned: number[];
  datesMentioned: string[];
  mentionsAlreadyPaid: boolean;
  mentionsWrongPerson: boolean;
  mentionsRecording: boolean;
  mentionsLegal: boolean;
  mentionsCompetitor: boolean;
  mentionsHardship: boolean;
  mentionsSelfHarm: boolean;
  refusesPayment: boolean;
  asksForCallback: boolean;
}

export interface AgentSignals {
  amountsSpoken: number[];
  unauthorisedAmounts: number[];
  repeatedTurns: number;
  questionsAsked: number;
}

export interface CallAnalytics {
  turnCount: number;
  agentTurns: number;
  callerTurns: number;
  agentWords: number;
  callerWords: number;
  talkRatio: number;
  avgAgentWords: number;
  avgCallerWords: number;
  longestCallerTurn: number;
  language: { devanagariPct: number; bengaliPct: number; latinPct: number };
  objections: ObjectionHit[];
  caller: CallerSignals;
  agent: AgentSignals;
}

const EMPTY_CALLER: CallerSignals = {
  amountsMentioned: [],
  datesMentioned: [],
  mentionsAlreadyPaid: false,
  mentionsWrongPerson: false,
  mentionsRecording: false,
  mentionsLegal: false,
  mentionsCompetitor: false,
  mentionsHardship: false,
  mentionsSelfHarm: false,
  refusesPayment: false,
  asksForCallback: false,
};

export function analyseTurns(config: BotConfig, turns: Turn[]): CallAnalytics {
  const agentTurns = turns.filter((turn) => turn.role === "agent");
  const callerTurns = turns.filter((turn) => turn.role === "caller");

  const agentWords = agentTurns.reduce((total, turn) => total + wordCount(turn.textEn), 0);
  const callerWords = callerTurns.reduce((total, turn) => total + wordCount(turn.textEn), 0);
  const spokenWords = agentWords + callerWords;

  const objections = detectObjections(config, callerTurns);
  const caller = detectCallerSignals(callerTurns);
  const agent = detectAgentSignals(config, agentTurns);

  return {
    turnCount: turns.length,
    agentTurns: agentTurns.length,
    callerTurns: callerTurns.length,
    agentWords,
    callerWords,
    talkRatio: spokenWords === 0 ? 0 : round(agentWords / spokenWords, 3),
    avgAgentWords: agentTurns.length === 0 ? 0 : round(agentWords / agentTurns.length, 1),
    avgCallerWords: callerTurns.length === 0 ? 0 : round(callerWords / callerTurns.length, 1),
    longestCallerTurn: callerTurns.reduce((max, turn) => Math.max(max, wordCount(turn.textEn)), 0),
    language: detectLanguage(callerTurns),
    objections,
    caller,
    agent,
  };
}

function wordCount(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function detectObjections(config: BotConfig, callerTurns: Turn[]): ObjectionHit[] {
  const hits = new Map<string, ObjectionHit>();

  for (const turn of callerTurns) {
    const text = turn.textEn.toLowerCase();
    if (!text) continue;

    for (const rule of config.objections) {
      if (hits.has(rule.type)) continue;
      const trigger = rule.triggers.find((needle) => text.includes(needle.toLowerCase()));
      if (!trigger) continue;

      hits.set(rule.type, {
        type: rule.type,
        evidence: clip(turn.textEn, 160),
        turnIndex: turn.index,
      });
    }
  }

  return [...hits.values()];
}

function detectCallerSignals(callerTurns: Turn[]): CallerSignals {
  const signals: CallerSignals = { ...EMPTY_CALLER, amountsMentioned: [], datesMentioned: [] };
  const amounts = new Set<number>();
  const dates = new Set<string>();

  for (const turn of callerTurns) {
    const text = turn.textEn;
    const lower = text.toLowerCase();

    for (const hit of extractAmounts(text)) amounts.add(hit.value);

    for (const chunk of text.split(/[,.;!?]/)) {
      const parsed = parseFlexibleDate(chunk.trim());
      if (parsed && parsed !== "1970-01-01") dates.add(parsed);
    }

    if (/already paid|pehle de diya|pay kar (?:chuka|diya)|payment ho gaya/.test(lower)) {
      signals.mentionsAlreadyPaid = true;
    }
    if (/galat number|wrong number|unka bhai|unka beta|not here|ghar par nahi|koi \w+ nahi/.test(lower)) {
      signals.mentionsWrongPerson = true;
    }
    if (/record(?:ing)? (?:mat|band|na)|why.*record|recording kyun/.test(lower)) {
      signals.mentionsRecording = true;
    }
    if (/\bcourt\b|\bpolice\b|\bfir\b|lawyer|vakil|legal|complaint|consumer forum/.test(lower)) {
      signals.mentionsLegal = true;
    }
    if (/policybazaar|acko|digit|dusri company|other company|online sasta|cheaper online/.test(lower)) {
      signals.mentionsCompetitor = true;
    }
    if (/hospital|medical|bimari|ilaj|accident|job chali|business down/.test(lower)) {
      signals.mentionsHardship = true;
    }
    if (/suicide|jaan de|marna|khatam kar|end my life/.test(lower)) {
      signals.mentionsSelfHarm = true;
    }
    if (/nahi dunga|won'?t pay|will not pay|nahi karunga|refuse/.test(lower)) {
      signals.refusesPayment = true;
    }
    if (/baad mein call|call later|later call|busy|meeting|soch ke bat/.test(lower)) {
      signals.asksForCallback = true;
    }
  }

  signals.amountsMentioned = [...amounts].sort((a, b) => a - b);
  signals.datesMentioned = [...dates].sort();
  return signals;
}

function detectAgentSignals(config: BotConfig, agentTurns: Turn[]): AgentSignals {
  const allowed = new Set(config.allowedCommitmentAmounts);
  const facts = new Set<number>();
  for (const value of Object.values(config.money)) {
    if (typeof value === "number") facts.add(value);
  }

  const amountsSpoken = new Set<number>();
  const unauthorised = new Set<number>();

  for (const turn of agentTurns) {
    for (const hit of extractAmounts(turn.textEn)) {
      amountsSpoken.add(hit.value);
      if (!facts.has(hit.value) && !allowed.has(hit.value)) unauthorised.add(hit.value);
    }
  }

  return {
    amountsSpoken: [...amountsSpoken].sort((a, b) => a - b),
    unauthorisedAmounts: [...unauthorised].sort((a, b) => a - b),
    repeatedTurns: countRepeats(agentTurns),
    questionsAsked: agentTurns.filter((turn) => /\?/.test(turn.textEn)).length,
  };
}

/**
 * The bug that shows up in half of all generated voice prompts: the same
 * sentence twice. Normalised comparison, because punctuation drifts.
 */
function countRepeats(agentTurns: Turn[]): number {
  let repeats = 0;
  for (let i = 1; i < agentTurns.length; i += 1) {
    const current = normalise(agentTurns[i]?.textEn ?? "");
    const previous = normalise(agentTurns[i - 1]?.textEn ?? "");
    if (current.length > 12 && current === previous) repeats += 1;
  }
  return repeats;
}

function normalise(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

function detectLanguage(callerTurns: Turn[]): CallAnalytics["language"] {
  let devanagari = 0;
  let bengali = 0;
  let latin = 0;

  for (const turn of callerTurns) {
    const text = turn.textIndic || turn.textEn;
    for (const char of text) {
      if (/[\u0900-\u097F]/.test(char)) devanagari += 1;
      else if (/[\u0980-\u09FF]/.test(char)) bengali += 1;
      else if (/[A-Za-z]/.test(char)) latin += 1;
    }
  }

  const total = devanagari + bengali + latin;
  if (total === 0) return { devanagariPct: 0, bengaliPct: 0, latinPct: 0 };

  return {
    devanagariPct: round((devanagari / total) * 100, 1),
    bengaliPct: round((bengali / total) * 100, 1),
    latinPct: round((latin / total) * 100, 1),
  };
}

function clip(text: string, max: number): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length <= max ? clean : `${clean.slice(0, max - 1)}…`;
}
