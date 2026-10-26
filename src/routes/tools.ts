import { randomUUID } from "node:crypto";
import { Router, type Request, type Response } from "express";
import { loadBotConfig, resolveBotKey } from "../config.js";
import { createStore } from "../db/store.js";
import { formatDateHuman, istToday } from "../lib/dates.js";
import { requireToolSecret } from "../lib/auth.js";
import { normalizeEscalationReason, validateCommitment } from "../lib/guardrails.js";
import { formatINR } from "../lib/money.js";
import {
  pickBoolean,
  pickString,
  resolveInteractionId,
  unwrapTool,
  type Json,
} from "../lib/payload.js";
import { hashPhone, normalizePhone } from "../lib/phone.js";

/**
 * Tool endpoints called by the agent mid-call.
 *
 * Contract with the model: always HTTP 200, with a `result` of accepted or
 * rejected and a `speak` line it can use verbatim. A 4xx/5xx makes the model
 * apologise to the caller and improvise, which is exactly what we do not want
 * when the subject is money.
 */
export const toolsRouter = Router();

toolsRouter.use(requireToolSecret());

toolsRouter.post("/:botKey/log-commitment", logCommitment);
toolsRouter.post("/log-commitment", logCommitment);
toolsRouter.post("/:botKey/escalate", escalate);
toolsRouter.post("/escalate", escalate);

async function logCommitment(req: Request, res: Response): Promise<void> {
  const startedAt = Date.now();
  const store = createStore();
  const { meta, args: bodyArgs } = unwrapTool(req.body);
  // Sarvam sends tool arguments either in the JSON body or as query params,
  // depending on which tab the tool was configured on. Accept both.
  const args = { ...(req.query as Record<string, unknown>), ...bodyArgs };

  const botKey = resolveBotKey(req.params.botKey, req.query.bot, args.bot_key);
  const config = loadBotConfig(botKey);
  const today = istToday();

  const phone = normalizePhone(pickString(args, ["user_phone_number", "phone_number", "caller_number"]));
  const fallbackKey = `phone:${phone ? hashPhone(phone, process.env.CALLER_HASH_SALT) : "unknown"}:${today}`;
  const interactionId = resolveInteractionId(args, fallbackKey);

  const existing = await store.getCommitment(interactionId);
  const rightParty =
    pickBoolean(args, ["right_party_confirmed", "right_party", "identity_confirmed"]) ??
    !config.commitmentPolicy.requireRightParty;

  // Every borrower has their own principal, settlement and expiry. Without this
  // lookup, a second customer's genuine figure would be rejected as unauthorised.
  const phoneHash = phone ? hashPhone(phone, process.env.CALLER_HASH_SALT) : null;
  const customer = phoneHash ? await store.findCustomerByHash(phoneHash) : null;
  const allowedAmounts = customer
    ? [customer.settlementOffer, customer.totalOutstanding].filter((value) => value > 0)
    : undefined;

  const decision = validateCommitment(
    {
      amount: args.amount ?? args.committed_amount ?? args.payment_amount,
      date: args.date ?? args.commitment_date ?? args.promised_date ?? args.payment_date,
      mode: args.mode ?? args.payment_mode ?? args.method,
      reference: args.reference ?? args.reference_number ?? args.utr,
      right_party_confirmed: rightParty,
    },
    {
      config,
      today,
      existingCommitment: Boolean(existing),
      rightPartyConfirmed: rightParty,
      allowedAmounts,
      offerValidTill: customer?.offerValidTill ?? undefined,
    },
  );

  if (!decision.ok) {
    const response = {
      ok: false,
      result: "rejected",
      code: decision.code,
      message: `${decision.agentInstruction} Say exactly: "${decision.speak}"`,
      speak: decision.speak,
    };

    await store.logToolCall({
      interactionId,
      toolName: "log_commitment",
      request: args,
      statusCode: 200,
      response,
      latencyMs: Date.now() - startedAt,
    });

    console.warn(
      `[tool] ${botKey} log_commitment REJECTED (${decision.code}) interaction=${interactionId}`,
    );

    res.status(200).json(response);
    return;
  }

  const reference =
    decision.value.reference || `CMP-${interactionId.slice(-6).toUpperCase()}`;

  const created = await store.createCommitment({
    interactionId,
    amount: decision.value.amount,
    date: decision.value.date,
    mode: decision.value.mode,
    reference,
  });

  if (!created) {
    const response = {
      ok: false,
      result: "rejected",
      code: "duplicate_commitment",
      message:
        "A commitment is already recorded for this call. Do not change it. Confirm it once and close the call.",
      speak: "Ji, aapki baat note ho gayi hai. Main confirm karke rakhta hoon.",
    };

    await store.logToolCall({
      interactionId,
      toolName: "log_commitment",
      request: args,
      statusCode: 200,
      response,
      latencyMs: Date.now() - startedAt,
    });

    res.status(200).json(response);
    return;
  }

  const response = {
    ok: true,
    result: "accepted",
    commitment: {
      amount: decision.value.amount,
      amount_display: formatINR(decision.value.amount),
      date: decision.value.date,
      date_display: formatDateHuman(decision.value.date),
      mode: decision.value.mode,
      reference,
    },
    message:
      `Recorded. Confirm back to the caller: ${formatINR(decision.value.amount)} on ` +
      `${formatDateHuman(decision.value.date)} by ${decision.value.mode.toUpperCase()}. ` +
      "Ask if they want the payment link on this number, then close. Do not renegotiate.",
    speak:
      `${formatINR(decision.value.amount)} ${formatDateHuman(decision.value.date)} ko, ` +
      `${decision.value.mode.toUpperCase()} se. Main note kar raha hoon.`,
  };

  await store.logToolCall({
    interactionId,
    toolName: "log_commitment",
    request: args,
    statusCode: 200,
    response,
    latencyMs: Date.now() - startedAt,
  });

  console.info(
    `[tool] ${botKey} log_commitment ACCEPTED ${decision.value.amount} on ${decision.value.date} interaction=${interactionId}`,
  );

  res.status(200).json(response);
}

async function escalate(req: Request, res: Response): Promise<void> {
  const startedAt = Date.now();
  const store = createStore();
  const { args: bodyArgs } = unwrapTool(req.body);
  const args = { ...(req.query as Record<string, unknown>), ...bodyArgs };

  const botKey = resolveBotKey(req.params.botKey, req.query.bot, args.bot_key);
  const config = loadBotConfig(botKey);

  const reason = normalizeEscalationReason(
    args.reason ?? args.escalation_reason ?? args.issue,
    config,
  );

  const phone = normalizePhone(pickString(args, ["user_phone_number", "phone_number", "caller_number"]));
  const fallbackKey = `phone:${phone ? hashPhone(phone, process.env.CALLER_HASH_SALT) : "unknown"}:${istToday()}`;
  const interactionId = resolveInteractionId(args, fallbackKey);

  const ticket = `ESC-${istToday().replace(/-/g, "")}-${randomUUID().slice(0, 6).toUpperCase()}`;
  // Nobody can follow "ESC-20261026-9F3A1C" read aloud. Speak four digits and
  // keep the full ticket for the CRM.
  const spokenReference = String(
    1000 + (parseInt(randomUUID().replace(/-/g, "").slice(0, 6), 16) % 9000),
  );

  await store.createEscalation({
    interactionId,
    reason,
    slaHours: config.escalation.slaHours,
    ticket,
  });

  const response = {
    ok: true,
    result: "accepted",
    ticket,
    spoken_reference: spokenReference,
    reason,
    sla_hours: config.escalation.slaHours,
    message:
      `Escalation ${ticket} logged. A senior will call within ${config.escalation.slaHours} hours. ` +
      `Read only the four digit reference ${spokenReference} to the caller, never the full ticket. ` +
      "Do not promise a different amount or a different timeline. Then end the call politely.",
    speak:
      `Main isko senior ko de raha hoon, aapko ${config.escalation.slaHours} ghante mein call aayega. ` +
      `Aapka reference number ${spokenReference} hai.`,
  };

  await store.logToolCall({
    interactionId,
    toolName: "escalate_to_human",
    request: args as Json,
    statusCode: 200,
    response,
    latencyMs: Date.now() - startedAt,
  });

  console.warn(`[tool] ${botKey} escalate ${ticket} reason=${reason} interaction=${interactionId}`);

  res.status(200).json(response);
}
