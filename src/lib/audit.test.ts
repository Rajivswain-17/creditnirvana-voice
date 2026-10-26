import assert from "node:assert/strict";
import test from "node:test";
import { loadBotConfig } from "../config.js";
import { analyseTurns, type Turn } from "./analytics.js";
import { auditCall, scoreCall } from "./audit.js";

/**
 * The audit has to catch the failures a live test call produced, using only
 * the transcript. These cases are copied from real transcripts.
 */

const config = loadBotConfig("loan_settlement");

function run(turns: Turn[], overrides: Partial<Parameters<typeof auditCall>[0]> = {}) {
  const analytics = analyseTurns(config, turns);
  const findings = auditCall({
    config,
    turns,
    analytics,
    rightPartyConfirmed: true,
    escalationCount: 0,
    commitment: null,
    startedAt: new Date("2026-10-26T11:00:00+05:30"),
    durationSeconds: 180,
    disposition: "settlement_agreed",
    ...overrides,
  });
  return { analytics, findings, score: scoreCall(findings, analytics) };
}

test("flags an unauthorised amount and an unescalated legal threat", () => {
  const turns: Turn[] = [
    { index: 0, role: "agent", textEn: "Main Rohit bol raha hoon CreditNirvana se." },
    { index: 1, role: "caller", textEn: "Haan boliye." },
    { index: 2, role: "agent", textEn: "Aapko four lakh thirty thousand dene honge." },
    { index: 3, role: "caller", textEn: "Main court jaunga, mere lawyer ne bola hai." },
  ];

  const { findings, score } = run(turns, { disposition: null });
  const types = findings.map((finding) => finding.type);

  assert.ok(types.includes("unauthorised_amount_spoken"));
  assert.ok(types.includes("unaddressed_legal_threat"));
  assert.notEqual(score.grade, "A");
});

test("does not flag an authorised amount", () => {
  const turns: Turn[] = [
    { index: 0, role: "agent", textEn: "Total six lakh fifty thousand hai." },
    { index: 1, role: "caller", textEn: "Settlement kitna?" },
    { index: 2, role: "agent", textEn: "Settlement four lakh, thirty one October tak." },
  ];

  const { findings } = run(turns);
  const types = findings.map((finding) => finding.type);
  assert.ok(!types.includes("unauthorised_amount_spoken"));
});

test("flags money talk while the borrower is unconfirmed", () => {
  const turns: Turn[] = [
    { index: 0, role: "agent", textEn: "Rajiv ji se baat ho rahi hai?" },
    { index: 1, role: "caller", textEn: "Main unka bhai hoon, wo ghar par nahi hai." },
    { index: 2, role: "agent", textEn: "Unka loan outstanding six lakh fifty thousand hai." },
  ];

  const { findings } = run(turns, { rightPartyConfirmed: false, disposition: "wrong_person" });
  assert.ok(findings.some((finding) => finding.type === "disclosure_to_third_party"));
});

test("flags a repeated sentence", () => {
  const turns: Turn[] = [
    { index: 0, role: "agent", textEn: "Yeh teesra reason hai." },
    { index: 1, role: "caller", textEn: "Theek hai." },
    { index: 2, role: "agent", textEn: "Yeh teesra reason hai." },
  ];

  const { findings } = run(turns);
  assert.ok(findings.some((finding) => finding.type === "repeated_sentence"));
});

test("flags a call outside the permitted window", () => {
  const turns: Turn[] = [
    { index: 0, role: "agent", textEn: "Namaste, main Rohit bol raha hoon." },
    { index: 1, role: "caller", textEn: "Haan." },
  ];

  const { findings } = run(turns, { startedAt: new Date("2026-10-26T03:30:00+05:30") });
  assert.ok(findings.some((finding) => finding.type === "outside_call_window"));
});

test("computes talk ratio and objections", () => {
  const turns: Turn[] = [
    { index: 0, role: "agent", textEn: "Namaste sir main Rohit bol raha hoon CreditNirvana se aapke loan ke baare mein." },
    { index: 1, role: "caller", textEn: "Main abhi busy hoon, baad mein call karna." },
    { index: 2, role: "agent", textEn: "Sir yeh settlement ka last chance hai, aaj hi confirm kar dijiye." },
    { index: 3, role: "caller", textEn: "Paisa nahi hai abhi." },
  ];

  const analytics = analyseTurns(config, turns);
  assert.ok(analytics.talkRatio > 0.5);
  assert.ok(analytics.objections.some((objection) => objection.type === "callback"));
  assert.ok(analytics.objections.some((objection) => objection.type === "affordability"));
  assert.equal(analytics.callerTurns, 2);
});
