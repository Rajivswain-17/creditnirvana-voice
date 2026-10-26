import { randomUUID } from "node:crypto";
import { Router, type Request, type Response } from "express";
import { loadBotConfig, resolveBotKey } from "../config.js";
import { createStore } from "../db/store.js";
import { analyseTurns, type Turn } from "../lib/analytics.js";
import { auditCall, scoreCall, type Finding } from "../lib/audit.js";
import {
  asObject,
  pickArray,
  pickBoolean,
  pickNumber,
  pickString,
  resolveInteractionId,
  type Json,
} from "../lib/payload.js";
import { hashPhone, last4, normalizePhone } from "../lib/phone.js";

/**
 * POST /webhook/sarvam
 *
 * Fires once per finished call. Three things happen here, in this order:
 *   1. the transcript is rebuilt into turns,
 *   2. analytics and the compliance audit run in code,
 *   3. everything is written idempotently, keyed on interaction_id.
 *
 * Step 2 is the point. The model's own `compliance_flag` variable is stored,
 * but it is not trusted: a call can be flagged by us even when the model said
 * everything was fine.
 */
export const webhookRouter = Router();

webhookRouter.post("/sarvam", handle);
webhookRouter.post("/sarvam/:botKey", handle);

const AGENT_ROLES = /^(agent|assistant|bot|ai|system)$/i;

async function handle(req: Request, res: Response): Promise<void> {
  const token = process.env.WEBHOOK_TOKEN;
  if (token && req.get("x-webhook-token") !== token && req.query.token !== token) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }

  const body = asObject(req.body);
  const botKey = resolveBotKey(
    req.params.botKey,
    req.query.bot,
    pickString(body, ["bot_key"]),
    pickString(body, ["app_name", "agent_name"]),
  );
  const config = loadBotConfig(botKey);
  const store = createStore();

  const interactionId = resolveInteractionId(body, `unknown-${randomUUID()}`);
  const turns = extractTurns(body);

  const finalVariables = asObject(
    body.final_agent_variables ?? body.finalVariables ?? body.input_variables ?? {},
  );
  const outputVariables = asObject(
    body.output_agent_variables ?? body.outputVariables ?? body.variables ?? {},
  );

  const phone = normalizePhone(
    pickString(body, ["user_phone_number", "phone_number", "from", "caller", "customer_phone"]),
  );

  const callerHash = phone ? hashPhone(phone, process.env.CALLER_HASH_SALT) : "unknown";
  const customer = phone ? await store.findCustomerByHash(callerHash) : null;
  const extraAllowedAmounts = customer
    ? [
        customer.principalDue,
        customer.interestDue,
        customer.otherCharges,
        customer.totalOutstanding,
        customer.settlementOffer,
      ]
    : [];

  const startedAt = parseDate(
    pickString(body, ["start_datetime", "started_at", "start_time", "call_started_at"]),
  );
  const endedAt = parseDate(
    pickString(body, ["end_datetime", "ended_at", "end_time", "call_ended_at"]),
  );

  const durationSeconds =
    pickNumber(body, ["duration", "duration_seconds", "call_duration", "call_duration_seconds"]) ??
    (startedAt && endedAt ? Math.max(0, Math.round((endedAt.getTime() - startedAt.getTime()) / 1000)) : 0);

  const analytics = analyseTurns(config, turns);

  const rightPartyConfirmed =
    pickBoolean(outputVariables, ["right_party_confirmed", "right_party"]) ??
    pickBoolean(finalVariables, ["right_party_confirmed", "right_party"]) ??
    !analytics.caller.mentionsWrongPerson;

  const disposition =
    pickString(outputVariables, ["call_disposition", "disposition", "outcome"]) ??
    pickString(finalVariables, ["call_disposition"]);

  const escalationReason = pickString(outputVariables, ["escalation_reason"]);
  const escalationCount =
    escalationReason && escalationReason.toLowerCase() !== "none" ? 1 : 0;

  const storedCommitment = await store.getCommitment(interactionId);
  const commitment = storedCommitment
    ? { amount: storedCommitment.amount, date: storedCommitment.date }
    : commitmentFromVariables(outputVariables);

  const findings: Finding[] = auditCall({
    config,
    turns,
    analytics,
    rightPartyConfirmed,
    escalationCount,
    commitment,
    startedAt,
    durationSeconds,
    disposition,
    extraAllowedAmounts,
  });

  const score = scoreCall(findings, analytics);

  const callId = await store.saveCall(
    {
      interactionId,
      appId: pickString(body, ["app_id", "appId"]) ?? "",
      appVersion: pickNumber(body, ["app_version", "version"]) ?? 0,
      deploymentId: pickString(body, ["deployment_id", "deploymentId"]) ?? "",
      botKey,
      callerHash,
      callerLast4: phone ? last4(phone) : "0000",
      agentNumber: pickString(body, ["agent_number", "called_number", "to"]) ?? "",
      durationSeconds,
      startedAt,
      endedAt,
      disposition,
      language: pickString(outputVariables, ["language", "call_language"]) ?? null,
      rightPartyConfirmed,
      finalVariables,
      outputVariables,
      analytics,
      score: score.total,
    },
    turns,
    findings,
  );

  await store.linkCall(interactionId, callId);

  console.info(
    `[webhook] ${botKey} ${interactionId} turns=${turns.length} score=${score.total}(${score.grade}) findings=${findings.length}`,
  );

  res.status(200).json({
    ok: true,
    call_id: callId,
    score: score.total,
    grade: score.grade,
    findings: findings.map((finding) => finding.type),
    commitment: commitment?.amount ?? null,
    talk_ratio: analytics.talkRatio,
  });
}

function extractTurns(body: Json): Turn[] {
  const raw = pickArray(body, [
    "interaction_transcript",
    "transcript",
    "messages",
    "turns",
    "conversation",
  ]);

  const mapped: Turn[] = [];

  raw.forEach((entry) => {
    const turn = asObject(entry);
    const roleRaw = pickString(turn, ["role", "speaker", "author", "type"]) ?? "";
    const textEn =
      pickString(turn, ["en_text", "enText", "text", "content", "transcript", "message"]) ??
      pickString(turn, ["indic_text", "indicText", "original_text"]) ??
      "";

    if (!textEn) return;

    mapped.push({
      index: mapped.length,
      role: AGENT_ROLES.test(roleRaw) ? "agent" : "caller",
      textEn,
      textIndic: pickString(turn, ["indic_text", "indicText", "original_text"]) ?? undefined,
    });
  });

  return mapped;
}

function commitmentFromVariables(output: Json): { amount: number; date: string } | null {
  const amount = pickNumber(output, ["committed_amount", "commitment_amount"]);
  const date = pickString(output, ["commitment_date"]);
  if (!amount || !date) return null;
  return { amount, date };
}

function parseDate(value: string | null): Date | null {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}
