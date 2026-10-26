import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

/**
 * Known borrowers. Looked up by the hash of the caller's number at call start.
 *
 * The phone number itself never lands here: on-start hashes the ANI with
 * CALLER_HASH_SALT and we match on that. If the hash misses, the agent falls
 * back to verbal identity verification instead of disclosing anything.
 */
export const customers = pgTable(
  "customers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    phoneHash: text("phone_hash").notNull(),
    name: text("name").notNull(),
    principalDue: integer("principal_due").notNull().default(0),
    interestDue: integer("interest_due").notNull().default(0),
    otherCharges: integer("other_charges").notNull().default(0),
    totalOutstanding: integer("total_outstanding").notNull().default(0),
    settlementOffer: integer("settlement_offer").notNull().default(0),
    offerValidTill: text("offer_valid_till"),
    daysOverdue: integer("days_overdue").notNull().default(0),
    language: text("language").notNull().default("hi-IN"),
    active: boolean("active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("customers_phone_hash_idx").on(t.phoneHash)],
);

/**
 * One row per finished call. Populated from the Sarvam deployment webhook.
 * Caller phone number is stored only as an HMAC hash plus the last four digits.
 */
export const calls = pgTable(
  "calls",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    interactionId: text("interaction_id").notNull(),
    appId: text("app_id").notNull().default(""),
    appVersion: integer("app_version").notNull().default(0),
    deploymentId: text("deployment_id").notNull().default(""),
    botKey: text("bot_key").notNull().default("loan_settlement"),

    callerHash: text("caller_hash").notNull(),
    callerLast4: text("caller_last4").notNull(),
    agentNumber: text("agent_number").notNull().default(""),

    durationSeconds: integer("duration_seconds").notNull().default(0),
    startedAt: timestamp("started_at", { withTimezone: true }),
    endedAt: timestamp("ended_at", { withTimezone: true }),

    disposition: text("disposition"),
    language: text("language"),
    rightPartyConfirmed: boolean("right_party_confirmed"),
    finalVariables: jsonb("final_variables"),
    outputVariables: jsonb("output_variables"),

    analytics: jsonb("analytics"),
    score: integer("score"),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("calls_interaction_id_idx").on(t.interactionId),
    index("calls_created_at_idx").on(t.createdAt),
  ],
);

/** One row per spoken turn. This is the raw material for every metric below. */
export const callTurns = pgTable(
  "call_turns",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    callId: uuid("call_id")
      .notNull()
      .references(() => calls.id, { onDelete: "cascade" }),
    turnIndex: integer("turn_index").notNull(),
    role: text("role").notNull(),
    textEn: text("text_en").notNull().default(""),
    textIndic: text("text_indic"),
    wordCount: integer("word_count").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("call_turns_call_turn_idx").on(t.callId, t.turnIndex)],
);

/**
 * Every tool call the agent made, including the ones we rejected.
 * A rejected call is the most interesting row in this table: it is the moment
 * the model tried to promise something the business cannot honour.
 *
 * Written while the call is still running, so call_id is filled in later by
 * linkEvents() once the webhook creates the call row.
 */
export const toolCalls = pgTable(
  "tool_calls",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    callId: uuid("call_id").references(() => calls.id, { onDelete: "cascade" }),
    interactionId: text("interaction_id"),
    toolName: text("tool_name").notNull(),
    requestBody: jsonb("request_body"),
    statusCode: integer("status_code").notNull(),
    responseBody: jsonb("response_body"),
    latencyMs: integer("latency_ms").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("tool_calls_call_idx").on(t.callId),
    index("tool_calls_interaction_idx").on(t.interactionId),
  ],
);

/**
 * At most one commitment per call. The unique index is the enforcement: even if
 * the model calls the tool twice, or two workers race, the second insert fails.
 */
export const commitments = pgTable(
  "commitments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    callId: uuid("call_id").references(() => calls.id, { onDelete: "cascade" }),
    interactionId: text("interaction_id").notNull(),
    amount: integer("amount").notNull(),
    promisedDate: text("promised_date").notNull(),
    mode: text("mode").notNull(),
    reference: text("reference").notNull().default(""),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("commitments_interaction_idx").on(t.interactionId)],
);

/**
 * Post-call audit findings. These are produced by code, not by the model,
 * so they exist even when the prompt fails.
 */
export const violations = pgTable(
  "violations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    callId: uuid("call_id")
      .notNull()
      .references(() => calls.id, { onDelete: "cascade" }),
    type: text("type").notNull(),
    severity: text("severity").notNull(),
    evidence: text("evidence"),
    turnIndex: integer("turn_index"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("violations_call_idx").on(t.callId), index("violations_type_idx").on(t.type)],
);

export const escalations = pgTable(
  "escalations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    callId: uuid("call_id").references(() => calls.id, { onDelete: "cascade" }),
    interactionId: text("interaction_id").notNull(),
    reason: text("reason").notNull(),
    slaHours: integer("sla_hours").notNull().default(2),
    ticket: text("ticket").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("escalations_ticket_idx").on(t.ticket)],
);
