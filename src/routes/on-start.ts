import { Router, type Request, type Response } from "express";
import { defaultVariables, loadBotConfig, resolveBotKey, type BotConfig } from "../config.js";
import { createStore, type CustomerRecord } from "../db/store.js";
import { istToday } from "../lib/dates.js";
import { pickString, unwrapTool } from "../lib/payload.js";
import { hashPhone, last4, normalizePhone } from "../lib/phone.js";

/**
 * POST /on-start/:botKey
 *
 * Runs before the agent's first sentence. The caller's number is hashed and
 * matched against the borrower table; the reply fills the agent's input
 * variables so the prompt never contains a hardcoded name or amount.
 *
 * A miss is not an error. The agent gets the configured defaults and has to
 * verify identity verbally before it says anything about money, which is what
 * a collections process should do anyway.
 */
export const onStartRouter = Router();

const PHONE_KEYS = [
  "user_phone_number",
  "phone_number",
  "caller_number",
  "from",
  "caller",
  "ani",
  "customer_phone",
];

async function handle(req: Request, res: Response): Promise<void> {
  const startedAt = Date.now();
  const { meta, args } = unwrapTool(req.body);
  const botKey = resolveBotKey(
    req.params.botKey,
    req.query.bot,
    pickString(args, ["bot_key"]),
    pickString(meta, ["app_name", "agent_name"]),
  );
  const config = loadBotConfig(botKey);
  const store = createStore();
  const today = istToday();

  const phone = normalizePhone(pickString(args, PHONE_KEYS) ?? pickString(meta, PHONE_KEYS));
  const variables = defaultVariables(config, today);

  if (!phone) {
    console.warn(`[on-start] ${botKey}: no caller number in payload. Serving defaults.`);
    respond(res, variables, req.query.shape);
    return;
  }

  const phoneHash = hashPhone(phone, process.env.CALLER_HASH_SALT);
  const customer = await store.findCustomerByHash(phoneHash);

  if (!customer) {
    console.info(`[on-start] ${botKey}: caller ***${last4(phone)} not in borrower table.`);
    respond(res, variables, req.query.shape);
    return;
  }

  console.info(`[on-start] ${botKey}: matched ***${last4(phone)} -> ${customer.name} (${Date.now() - startedAt}ms)`);

  respond(res, withCustomer(config, variables, customer), req.query.shape);
}

/**
 * A matched customer overrides only what the bot actually sells. Insurance has
 * no principal or settlement, so it keeps its own variable contract and takes
 * nothing but the name: a collections-shaped reply here would blank every IDV
 * and premium variable the agent depends on.
 */
function withCustomer(
  config: BotConfig,
  variables: Record<string, string>,
  customer: CustomerRecord,
): Record<string, string> {
  if (config.vehicle) {
    return { ...variables, customer_name: customer.name };
  }
  return {
    customer_name: customer.name,
    principal_due: String(customer.principalDue),
    interest_due: String(customer.interestDue),
    other_charges: String(customer.otherCharges),
    total_outstanding: String(customer.totalOutstanding),
    settlement_offer: String(customer.settlementOffer),
    offer_valid_till: customer.offerValidTill ?? variables.offer_valid_till ?? "",
    days_overdue: String(customer.daysOverdue),
    current_date: variables.current_date ?? "",
  };
}

function respond(res: Response, variables: Record<string, string>, shape: unknown): void {
  // Sarvam accepts a flat map in the common case. ?shape=wrapped exists for the
  // agent configuration that expects { "variables": { ... } }.
  if (shape === "wrapped") {
    res.json({ variables });
    return;
  }
  res.json(variables);
}

onStartRouter.post("/", handle);
onStartRouter.post("/:botKey", handle);

/** Debug helper: /on-start/loan_settlement?phone=%2B919876543210 */
onStartRouter.get("/:botKey", async (req: Request, res: Response) => {
  const botKey = resolveBotKey(req.params.botKey);
  const config = loadBotConfig(botKey);
  const today = istToday();
  const store = createStore();
  const phone = normalizePhone(req.query.phone);

  if (!phone) {
    res.json({ ...defaultVariables(config, today), lookup: "no_phone" });
    return;
  }

  const customer = await store.findCustomerByHash(hashPhone(phone, process.env.CALLER_HASH_SALT));
  if (!customer) {
    res.json({ ...defaultVariables(config, today), lookup: "not_found" });
    return;
  }

  res.json({ ...withCustomer(config, defaultVariables(config, today), customer), lookup: "found" });
});
