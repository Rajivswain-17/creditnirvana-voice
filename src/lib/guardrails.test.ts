import assert from "node:assert/strict";
import test from "node:test";
import { loadBotConfig } from "../config.js";
import { parseFlexibleDate } from "./dates.js";
import { allowedFacts } from "../config.js";
import { extractAmounts } from "./money.js";
import { validateCommitment, type CommitmentContext } from "./guardrails.js";

/**
 * These are the money rules. If any of them regress, the company pays.
 */

const config = loadBotConfig("loan_settlement");

function ctx(overrides: Partial<CommitmentContext> = {}): CommitmentContext {
  return {
    config,
    today: "2026-10-26",
    existingCommitment: false,
    rightPartyConfirmed: true,
    ...overrides,
  };
}

test("accepts the authorised settlement on a valid date", () => {
  const result = validateCommitment(
    { amount: 400000, date: "2026-10-30", mode: "upi" },
    ctx(),
  );
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.value.amount, 400000);
    assert.equal(result.value.date, "2026-10-30");
    assert.equal(result.value.mode, "upi");
  }
});

test("accepts the full outstanding amount", () => {
  const result = validateCommitment(
    { amount: "6,50,000", date: "31 October 2026", mode: "NEFT" },
    ctx(),
  );
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.value.amount, 650000);
});

test("rejects 430000, the amount the model actually tried", () => {
  const result = validateCommitment(
    { amount: 430000, date: "2026-10-30", mode: "upi" },
    ctx(),
  );
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, "amount_not_authorised");
});

test("rejects a relative date instead of inventing one", () => {
  const result = validateCommitment(
    { amount: 400000, date: "agle shukravar", mode: "upi" },
    ctx(),
  );
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, "date_unclear");
});

test("rejects a date after the offer expires", () => {
  const result = validateCommitment(
    { amount: 400000, date: "2026-11-05", mode: "upi" },
    ctx(),
  );
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, "date_after_offer");
});

test("rejects a second commitment on the same call", () => {
  const result = validateCommitment(
    { amount: 400000, date: "2026-10-30", mode: "upi" },
    ctx({ existingCommitment: true }),
  );
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, "duplicate_commitment");
});

test("rejects cash", () => {
  const result = validateCommitment(
    { amount: 400000, date: "2026-10-30", mode: "cash" },
    ctx(),
  );
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, "mode_invalid");
});

test("rejects a commitment when identity is unconfirmed", () => {
  const result = validateCommitment(
    { amount: 400000, date: "2026-10-30", mode: "upi" },
    ctx({ rightPartyConfirmed: false }),
  );
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, "right_party_unconfirmed");
});

test("rejects a Sunday when the policy forbids it", () => {
  const relaxed = {
    ...config,
    money: { ...config.money, offerValidTill: "2026-12-31" },
    commitmentPolicy: { ...config.commitmentPolicy, sundaysAllowed: false },
  };
  const result = validateCommitment(
    { amount: 400000, date: "2026-11-01", mode: "upi" },
    { config: relaxed, today: "2026-10-26", existingCommitment: false, rightPartyConfirmed: true },
  );
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, "date_sunday");
});

test("parses explicit dates and refuses ambiguous ones", () => {
  assert.equal(parseFlexibleDate("31 October 2026"), "2026-10-31");
  assert.equal(parseFlexibleDate("30/10/2026"), "2026-10-30");
  assert.equal(parseFlexibleDate("2026-10-30"), "2026-10-30");
  assert.equal(parseFlexibleDate("agle shukravar"), null);
  assert.equal(parseFlexibleDate("31 February 2026"), null);
});

test("uses the matched borrower's figures instead of the portfolio default", () => {
  const result = validateCommitment(
    { amount: 280000, date: "2026-10-30", mode: "upi" },
    ctx({ allowedAmounts: [280000, 490000] }),
  );
  assert.equal(result.ok, true);
});

test("still rejects an amount that is not one of that borrower's figures", () => {
  const result = validateCommitment(
    { amount: 400000, date: "2026-10-30", mode: "upi" },
    ctx({ allowedAmounts: [280000, 490000] }),
  );
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, "amount_not_authorised");
});

test("reads 430000 out of spoken English", () => {
  const values = extractAmounts("Aapko four lakh thirty thousand rupees dene honge").map(
    (hit) => hit.value,
  );
  assert.ok(values.includes(430000));
  assert.ok(!allowedFacts(config).includes(430000));
});
