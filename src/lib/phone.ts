import { createHash } from "node:crypto";

/**
 * Caller identity helpers.
 *
 * The phone number is the lookup key, but it is never stored on the call.
 * We keep an HMAC-style hash plus the last four digits, which is enough for an
 * agent to say "aapke number ke aakhri chaar digit" and for us to debug, and
 * not enough to rebuild a contact list if the database leaks.
 */

export function normalizePhone(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const digits = raw.replace(/\D/g, "");
  if (!digits) return null;

  let national = digits;
  if (national.length === 12 && national.startsWith("91")) national = national.slice(2);
  else if (national.length === 11 && national.startsWith("0")) national = national.slice(1);

  if (national.length !== 10) return null;
  return `+91${national}`;
}

export function hashPhone(phone: string, salt: string | undefined): string {
  return createHash("sha256").update(`${salt ?? "dev-only-salt"}:${phone}`).digest("hex");
}

export function last4(phone: string): string {
  return phone.slice(-4);
}
