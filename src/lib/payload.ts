/**
 * Defensive parsing for Sarvam payloads.
 *
 * The platform is not consistently shaped across tool calls and webhooks:
 * sometimes arguments arrive nested under "arguments", sometimes flat,
 * sometimes JSON-encoded as a string. Rather than guess once and break in
 * production, every reader accepts the known variants.
 */

export type Json = Record<string, unknown>;

export function asObject(value: unknown): Json {
  if (typeof value === "string") {
    try {
      const parsed: unknown = JSON.parse(value);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Json) : {};
    } catch {
      return {};
    }
  }
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Json) : {};
}

export function pickString(source: Json, keys: string[]): string | null {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return null;
}

export function pickNumber(source: Json, keys: string[]): number | null {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && value.trim()) {
      const parsed = Number(value.replace(/[^\d.-]/g, ""));
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return null;
}

export function pickBoolean(source: Json, keys: string[]): boolean | null {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "boolean") return value;
    if (typeof value === "string") {
      const normalised = value.trim().toLowerCase();
      if (["true", "yes", "haan", "ha", "1", "confirmed"].includes(normalised)) return true;
      if (["false", "no", "nahi", "na", "0", "unconfirmed"].includes(normalised)) return false;
    }
  }
  return null;
}

export function pickArray(source: Json, keys: string[]): unknown[] {
  for (const key of keys) {
    const value = source[key];
    if (Array.isArray(value)) return value;
  }
  return [];
}

export interface UnwrappedTool {
  /** Top-level call metadata: interaction id, app id, phone. */
  meta: Json;
  /** The arguments the model produced. */
  args: Json;
}

/**
 * Tools usually arrive as { interaction_id, arguments: {...} }. Some send the
 * arguments flat. Both are supported, and the two views are merged for lookup
 * so a field in either place is found.
 */
export function unwrapTool(body: unknown): UnwrappedTool {
  const root = asObject(body);

  for (const key of ["arguments", "parameters", "args", "tool_input", "input_data", "tool_arguments"]) {
    const candidate = root[key];
    const parsed = asObject(candidate);
    if (Object.keys(parsed).length > 0) {
      return { meta: root, args: { ...root, ...parsed } };
    }
  }

  return { meta: root, args: root };
}

/**
 * Interaction id is the key that makes "one commitment per call" work.
 * If the platform omits it, we fall back to a caller-and-day key rather than
 * letting the guarantee silently disappear.
 */
export function resolveInteractionId(source: Json, fallbackKey: string): string {
  return (
    pickString(source, [
      "interaction_id",
      "interactionId",
      "call_id",
      "callId",
      "session_id",
      "conversation_id",
      "conversationId",
      "chat_id",
    ]) ?? fallbackKey
  );
}
