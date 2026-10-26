/**
 * Money parsing and formatting.
 *
 * Two jobs:
 *   1. Turn whatever the model sends into a number we can validate.
 *   2. Pull every amount out of a transcript so we can audit what was said.
 *
 * The second job is the important one. A prompt cannot be trusted to stay on
 * script, but a number in the transcript is a fact.
 */

const SCALES: Record<string, number> = {
  k: 1_000,
  thousand: 1_000,
  hazaar: 1_000,
  hajar: 1_000,
  lakh: 100_000,
  lakhs: 100_000,
  lac: 100_000,
  lacs: 100_000,
  crore: 10_000_000,
  cr: 10_000_000,
};

const WORD_NUMBERS: Record<string, number> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  fifteen: 15,
  twenty: 20,
  thirty: 30,
  forty: 40,
  fifty: 50,
  sixty: 60,
  seventy: 70,
  eighty: 80,
  ninety: 90,
};

export function formatINR(value: number): string {
  return `₹${Math.round(value).toLocaleString("en-IN")}`;
}

/** "4,00,000" | "4 lakh" | "₹4.5L" | 400000 -> 400000 */
export function parseAmount(raw: unknown): number | null {
  if (typeof raw === "number") {
    return Number.isFinite(raw) ? Math.round(raw) : null;
  }
  if (typeof raw !== "string") return null;

  const text = raw.toLowerCase().replace(/[₹,\s]/g, "");
  if (!text) return null;

  const match = /^(\d+(?:\.\d+)?)(k|thousand|hazaar|hajar|lakh|lakhs|lac|lacs|crore|cr)?$/.exec(text);
  if (!match) return null;

  const base = Number(match[1] ?? "");
  if (!Number.isFinite(base)) return null;

  const unit = match[2];
  const scale = unit ? (SCALES[unit] ?? 1) : 1;
  return Math.round(base * scale);
}

export interface AmountHit {
  value: number;
  raw: string;
  index: number;
}

/**
 * Extracts amounts from free text. Deliberately conservative: a bare number
 * under 1000 is not an amount, and a bare 1990-2100 is treated as a year.
 */
export function extractAmounts(text: string): AmountHit[] {
  if (!text) return [];

  const hits: AmountHit[] = [];
  const digitPattern =
    /(?:(?:₹|rs\.?|inr)\s*)?(\d[\d,]*(?:\.\d+)?)\s*(k|thousand|hazaar|hajar|lakh|lakhs|lac|lacs|crore|cr)?/gi;

  let match: RegExpExecArray | null;
  while ((match = digitPattern.exec(text)) !== null) {
    const numberText = match[1] ?? "";
    const unit = (match[2] ?? "").toLowerCase();
    const base = Number(numberText.replace(/,/g, ""));
    if (!Number.isFinite(base) || base === 0) continue;

    const hasCurrency = /₹|rs\.?|inr/i.test(match[0]);
    const scale = unit ? (SCALES[unit] ?? 1) : 1;
    const value = Math.round(base * scale);

    if (!unit && !hasCurrency) {
      if (value < 1000) continue;
      if (value >= 1900 && value <= 2100) continue; // a year, not money
    }

    hits.push({ value, raw: match[0].trim(), index: match.index });
  }

  const wordPattern =
    /\b(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)\s+(lakh|lakhs|lac|crore|thousand)\b/gi;

  while ((match = wordPattern.exec(text)) !== null) {
    const word = (match[1] ?? "").toLowerCase();
    const unit = (match[2] ?? "").toLowerCase();
    const base = WORD_NUMBERS[word];
    if (!base) continue;
    hits.push({ value: base * (SCALES[unit] ?? 1), raw: match[0], index: match.index });
  }

  // "four lakh thirty thousand" is one amount, not two. Without this rule the
  // compound splits into 400000 + 30000 and the audit loses the real figure.
  const compoundPattern =
    /\b(\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)\s+lakh\s+(?:and\s+)?(\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)\s+thousand\b/gi;

  while ((match = compoundPattern.exec(text)) !== null) {
    const lakhs = toNumber(match[1]);
    const thousands = toNumber(match[2]);
    if (lakhs === null || thousands === null) continue;
    hits.push({
      value: lakhs * 100_000 + thousands * 1_000,
      raw: match[0],
      index: match.index,
    });
  }

  // Drop sub-matches swallowed by a wider one: "six lakh fifty thousand" must
  // yield 650000 alone, not 650000 plus 600000 plus 50000.
  const spans = hits.map((hit) => ({ ...hit, end: hit.index + hit.raw.length }));
  const trimmed = spans.filter(
    (candidate) =>
      !spans.some(
        (other) =>
          other !== candidate &&
          other.index <= candidate.index &&
          other.end >= candidate.end &&
          other.end - other.index > candidate.end - candidate.index,
      ),
  );

  return trimmed
    .map(({ value, raw, index }) => ({ value, raw, index }))
    .sort((a, b) => a.index - b.index);
}

function toNumber(token: string | undefined): number | null {
  if (!token) return null;
  const lower = token.toLowerCase();
  if (/^\d+$/.test(lower)) return Number(lower);
  return WORD_NUMBERS[lower] ?? null;
}
