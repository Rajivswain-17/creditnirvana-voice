import { and, desc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import {
  callTurns,
  calls,
  commitments,
  customers,
  escalations,
  toolCalls,
  violations,
} from "./schema.js";
import type {
  CallDetail,
  CallListItem,
  CallRow,
  CallUpsert,
  CommitmentRecord,
  CustomerRecord,
  EscalationRecord,
  Store,
  StoredTurn,
  StoredViolation,
  ToolCallLog,
} from "./store.js";

/**
 * Postgres backend. Tables come from src/db/schema.ts via `npm run db:push`.
 *
 * Note the ordering in saveCall: the call row is upserted first, then turns and
 * findings are replaced. A retried webhook produces the same end state rather
 * than duplicate turns, which matters because Sarvam retries.
 */
export function createPostgresStore(connectionString: string): Store {
  const pool = new Pool({ connectionString, max: 5 });
  const db = drizzle(pool);

  return {
    kind: "postgres",

    async findCustomerByHash(phoneHash: string): Promise<CustomerRecord | null> {
      const rows = await db
        .select()
        .from(customers)
        .where(and(eq(customers.phoneHash, phoneHash), eq(customers.active, true)))
        .limit(1);

      const row = rows[0];
      if (!row) return null;

      return {
        phoneHash: row.phoneHash,
        name: row.name,
        principalDue: row.principalDue,
        interestDue: row.interestDue,
        otherCharges: row.otherCharges,
        totalOutstanding: row.totalOutstanding,
        settlementOffer: row.settlementOffer,
        offerValidTill: row.offerValidTill,
        daysOverdue: row.daysOverdue,
        language: row.language,
      };
    },

    async upsertCustomer(customer: CustomerRecord): Promise<void> {
      await db
        .insert(customers)
        .values({
          phoneHash: customer.phoneHash,
          name: customer.name,
          principalDue: customer.principalDue,
          interestDue: customer.interestDue,
          otherCharges: customer.otherCharges,
          totalOutstanding: customer.totalOutstanding,
          settlementOffer: customer.settlementOffer,
          offerValidTill: customer.offerValidTill,
          daysOverdue: customer.daysOverdue,
          language: customer.language,
        })
        .onConflictDoUpdate({
          target: customers.phoneHash,
          set: {
            name: customer.name,
            principalDue: customer.principalDue,
            interestDue: customer.interestDue,
            otherCharges: customer.otherCharges,
            totalOutstanding: customer.totalOutstanding,
            settlementOffer: customer.settlementOffer,
            offerValidTill: customer.offerValidTill,
            daysOverdue: customer.daysOverdue,
            language: customer.language,
            active: true,
          },
        });
    },

    async logToolCall(row: ToolCallLog): Promise<void> {
      await db.insert(toolCalls).values({
        interactionId: row.interactionId,
        toolName: row.toolName,
        requestBody: row.request,
        statusCode: row.statusCode,
        responseBody: row.response,
        latencyMs: row.latencyMs,
      });
    },

    async getCommitment(interactionId: string): Promise<CommitmentRecord | null> {
      const rows = await db
        .select()
        .from(commitments)
        .where(eq(commitments.interactionId, interactionId))
        .limit(1);

      const row = rows[0];
      if (!row) return null;

      return {
        interactionId: row.interactionId,
        amount: row.amount,
        date: row.promisedDate,
        mode: row.mode,
        reference: row.reference,
      };
    },

    async createCommitment(row: CommitmentRecord): Promise<boolean> {
      const inserted = await db
        .insert(commitments)
        .values({
          interactionId: row.interactionId,
          amount: row.amount,
          promisedDate: row.date,
          mode: row.mode,
          reference: row.reference,
        })
        .onConflictDoNothing({ target: commitments.interactionId })
        .returning({ id: commitments.id });

      return inserted.length > 0;
    },

    async createEscalation(row: EscalationRecord): Promise<boolean> {
      const inserted = await db
        .insert(escalations)
        .values({
          interactionId: row.interactionId,
          reason: row.reason,
          slaHours: row.slaHours,
          ticket: row.ticket,
        })
        .onConflictDoNothing({ target: escalations.ticket })
        .returning({ id: escalations.id });

      return inserted.length > 0;
    },

    async saveCall(
      input: CallUpsert,
      turns: StoredTurn[],
      findings: StoredViolation[],
    ): Promise<string> {
      const values = {
        interactionId: input.interactionId,
        appId: input.appId,
        appVersion: input.appVersion,
        deploymentId: input.deploymentId,
        botKey: input.botKey,
        callerHash: input.callerHash,
        callerLast4: input.callerLast4,
        agentNumber: input.agentNumber,
        durationSeconds: input.durationSeconds,
        startedAt: input.startedAt,
        endedAt: input.endedAt,
        disposition: input.disposition,
        language: input.language,
        rightPartyConfirmed: input.rightPartyConfirmed,
        finalVariables: input.finalVariables,
        outputVariables: input.outputVariables,
        analytics: input.analytics,
        score: input.score,
      };

      const upserted = await db
        .insert(calls)
        .values(values)
        .onConflictDoUpdate({ target: calls.interactionId, set: values })
        .returning({ id: calls.id });

      const id = upserted[0]?.id;
      if (!id) throw new Error("call upsert returned no row");

      await db.delete(callTurns).where(eq(callTurns.callId, id));
      if (turns.length > 0) {
        await db.insert(callTurns).values(
          turns.map((turn) => ({
            callId: id,
            turnIndex: turn.index,
            role: turn.role,
            textEn: turn.textEn,
            textIndic: turn.textIndic ?? null,
            wordCount: turn.textEn.trim().split(/\s+/).filter(Boolean).length,
          })),
        );
      }

      await db.delete(violations).where(eq(violations.callId, id));
      if (findings.length > 0) {
        await db.insert(violations).values(
          findings.map((finding) => ({
            callId: id,
            type: finding.type,
            severity: finding.severity,
            evidence: finding.evidence,
            turnIndex: finding.turnIndex ?? null,
          })),
        );
      }

      return id;
    },

    async linkCall(interactionId: string, callId: string): Promise<void> {
      await Promise.all([
        db.update(commitments).set({ callId }).where(eq(commitments.interactionId, interactionId)),
        db.update(escalations).set({ callId }).where(eq(escalations.interactionId, interactionId)),
        db.update(toolCalls).set({ callId }).where(eq(toolCalls.interactionId, interactionId)),
      ]);
    },

    async listCalls(limit: number): Promise<CallListItem[]> {
      const rows = await db
        .select({
          id: calls.id,
          interactionId: calls.interactionId,
          botKey: calls.botKey,
          durationSeconds: calls.durationSeconds,
          disposition: calls.disposition,
          score: calls.score,
          startedAt: calls.startedAt,
          commitmentAmount: commitments.amount,
        })
        .from(calls)
        .leftJoin(commitments, eq(commitments.callId, calls.id))
        .orderBy(desc(calls.createdAt))
        .limit(limit);

      return rows;
    },

    async getCall(callId: string): Promise<CallDetail | null> {
      const callRows = await db.select().from(calls).where(eq(calls.id, callId)).limit(1);
      const call = callRows[0] as CallRow | undefined;
      if (!call) return null;

      const [turnRows, violationRows, commitmentRows, escalationRows] = await Promise.all([
        db.select().from(callTurns).where(eq(callTurns.callId, callId)).orderBy(callTurns.turnIndex),
        db.select().from(violations).where(eq(violations.callId, callId)),
        db
          .select()
          .from(commitments)
          .where(eq(commitments.interactionId, call.interactionId)),
        db
          .select()
          .from(escalations)
          .where(eq(escalations.interactionId, call.interactionId)),
      ]);

      return {
        call,
        turns: turnRows.map((turn) => ({
          index: turn.turnIndex,
          role: turn.role as StoredTurn["role"],
          textEn: turn.textEn,
          textIndic: turn.textIndic ?? undefined,
        })),
        violations: violationRows.map((violation) => ({
          type: violation.type,
          severity: violation.severity,
          evidence: violation.evidence ?? "",
          turnIndex: violation.turnIndex ?? undefined,
        })),
        commitments: commitmentRows.map((row) => ({
          interactionId: row.interactionId,
          amount: row.amount,
          date: row.promisedDate,
          mode: row.mode,
          reference: row.reference,
        })),
        escalations: escalationRows.map((row) => ({
          interactionId: row.interactionId,
          reason: row.reason,
          slaHours: row.slaHours,
          ticket: row.ticket,
        })),
      };
    },
  };
}
