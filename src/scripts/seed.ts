import "dotenv/config";
import { loadBotConfig } from "../config.js";
import { createStore } from "../db/store.js";
import { hashPhone, normalizePhone } from "../lib/phone.js";

/**
 * Adds a borrower to the lookup table.
 *
 *   npm run seed -- +919876543210 Rajiv
 *   npm run seed -- +919123456789 Anuj 490000 280000
 *
 * Amounts are optional. Without them the borrower inherits the portfolio
 * defaults from config/loan_settlement.json, which is what the demo needs.
 *
 * The phone is hashed on the way in, so the table never holds a raw number.
 * Re-running the same number updates the record rather than duplicating it.
 */
async function main(): Promise<void> {
  const [, , rawPhone, rawName, rawTotal, rawSettlement] = process.argv;

  if (!rawPhone || !rawName) {
    console.error("usage: npm run seed -- <phone> <name> [total] [settlement]");
    process.exit(1);
  }

  const phone = normalizePhone(rawPhone);
  if (!phone) {
    console.error(`not a valid Indian mobile number: ${rawPhone}`);
    process.exit(1);
  }

  const config = loadBotConfig("loan_settlement");
  const store = createStore();

  const total = toRupees(rawTotal) ?? config.money.totalOutstanding;
  const settlement = toRupees(rawSettlement) ?? config.money.settlementOffer ?? 0;
  const interest = config.money.interestDue ?? 0;
  const charges = config.money.otherCharges ?? 0;
  const principal = Math.max(total - interest - charges, 0);

  await store.upsertCustomer({
    phoneHash: hashPhone(phone, process.env.CALLER_HASH_SALT),
    name: rawName,
    principalDue: principal,
    interestDue: interest,
    otherCharges: charges,
    totalOutstanding: total,
    settlementOffer: settlement,
    offerValidTill: config.money.offerValidTill ?? null,
    daysOverdue: config.money.daysOverdue ?? 0,
    language: "hi-IN",
  });

  console.info(
    `seeded ${rawName} (${phone}) total=${total} settlement=${settlement} into ${store.kind} store`,
  );
}

function toRupees(raw: string | undefined): number | null {
  if (!raw) return null;
  const value = Number(raw.replace(/[^\d]/g, ""));
  return Number.isFinite(value) && value > 0 ? value : null;
}

await main();
