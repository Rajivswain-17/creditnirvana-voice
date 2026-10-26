import { randomUUID } from "node:crypto";
import { createPostgresStore } from "./postgres.js";

/**
 * Storage contract.
 *
 * Two implementations:
 *   - memory:    zero setup, used when DATABASE_URL is absent. Loses data on restart.
 *   - postgres:  the real one.
 *
 * The interface is deliberately small. Everything that matters for compliance
 * (one commitment per call, every rejected tool call kept) is enforced here,
 * not in a route, so both backends behave the same.
 */

export interface CustomerRecord {
  phoneHash: string;
  name: string;
  principalDue: number;
  interestDue: number;
  otherCharges: number;
  totalOutstanding: number;
  settlementOffer: number;
  offerValidTill: string | null;
  daysOverdue: number;
  language: string;
}

export interface ToolCallLog {
  interactionId: string | null;
  toolName: string;
  request: unknown;
  statusCode: number;
  response: unknown;
  latencyMs: number;
}

export interface CommitmentRecord {
  interactionId: string;
  amount: number;
  date: string;
  mode: string;
  reference: string;
}

export interface EscalationRecord {
  interactionId: string;
  reason: string;
  slaHours: number;
  ticket: string;
}

export interface CallUpsert {
  interactionId: string;
  appId: string;
  appVersion: number;
  deploymentId: string;
  botKey: string;
  callerHash: string;
  callerLast4: string;
  agentNumber: string;
  durationSeconds: number;
  startedAt: Date | null;
  endedAt: Date | null;
  disposition: string | null;
  language: string | null;
  rightPartyConfirmed: boolean;
  finalVariables: unknown;
  outputVariables: unknown;
  analytics: unknown;
  score: number;
}

export interface StoredTurn {
  index: number;
  role: "agent" | "caller";
  textEn: string;
  textIndic?: string;
}

export interface StoredViolation {
  type: string;
  severity: string;
  evidence: string;
  turnIndex?: number;
}

export interface CallRow extends CallUpsert {
  id: string;
  createdAt: Date;
}

export interface CallListItem {
  id: string;
  interactionId: string;
  botKey: string;
  durationSeconds: number;
  disposition: string | null;
  score: number | null;
  startedAt: Date | null;
  commitmentAmount: number | null;
}

export interface CallDetail {
  call: CallRow;
  turns: StoredTurn[];
  violations: StoredViolation[];
  commitments: CommitmentRecord[];
  escalations: EscalationRecord[];
}

export interface Store {
  readonly kind: "memory" | "postgres";
  findCustomerByHash(phoneHash: string): Promise<CustomerRecord | null>;
  upsertCustomer(customer: CustomerRecord): Promise<void>;
  logToolCall(row: ToolCallLog): Promise<void>;
  getCommitment(interactionId: string): Promise<CommitmentRecord | null>;
  /** false when a commitment already exists for this interaction. */
  createCommitment(row: CommitmentRecord): Promise<boolean>;
  createEscalation(row: EscalationRecord): Promise<boolean>;
  saveCall(call: CallUpsert, turns: StoredTurn[], violations: StoredViolation[]): Promise<string>;
  linkCall(interactionId: string, callId: string): Promise<void>;
  listCalls(limit: number): Promise<CallListItem[]>;
  getCall(callId: string): Promise<CallDetail | null>;
}

// ---------------------------------------------------------------------------
// In-memory backend
// ---------------------------------------------------------------------------

export class MemoryStore implements Store {
  readonly kind = "memory" as const;

  private customers = new Map<string, CustomerRecord>();
  private toolCalls: ToolCallLog[] = [];
  private commitmentByInteraction = new Map<string, CommitmentRecord>();
  private escalations: EscalationRecord[] = [];
  private calls = new Map<string, CallRow>();
  private turnsByCall = new Map<string, StoredTurn[]>();
  private violationsByCall = new Map<string, StoredViolation[]>();

  async findCustomerByHash(phoneHash: string): Promise<CustomerRecord | null> {
    return this.customers.get(phoneHash) ?? null;
  }

  async upsertCustomer(customer: CustomerRecord): Promise<void> {
    this.customers.set(customer.phoneHash, customer);
  }

  async logToolCall(row: ToolCallLog): Promise<void> {
    this.toolCalls.push(row);
  }

  async getCommitment(interactionId: string): Promise<CommitmentRecord | null> {
    return this.commitmentByInteraction.get(interactionId) ?? null;
  }

  async createCommitment(row: CommitmentRecord): Promise<boolean> {
    if (this.commitmentByInteraction.has(row.interactionId)) return false;
    this.commitmentByInteraction.set(row.interactionId, row);
    return true;
  }

  async createEscalation(row: EscalationRecord): Promise<boolean> {
    if (this.escalations.some((existing) => existing.ticket === row.ticket)) return false;
    this.escalations.push(row);
    return true;
  }

  async saveCall(
    input: CallUpsert,
    turns: StoredTurn[],
    violations: StoredViolation[],
  ): Promise<string> {
    const existing = this.calls.get(input.interactionId);
    const id = existing?.id ?? randomUUID();

    this.calls.set(input.interactionId, {
      ...input,
      id,
      createdAt: existing?.createdAt ?? new Date(),
    });
    this.turnsByCall.set(id, turns);
    this.violationsByCall.set(id, violations);

    return id;
  }

  async linkCall(): Promise<void> {
    // Nothing to do: memory rows are already keyed by interaction id.
  }

  async listCalls(limit: number): Promise<CallListItem[]> {
    return [...this.calls.values()]
      .sort((a, b) => (b.startedAt?.getTime() ?? 0) - (a.startedAt?.getTime() ?? 0))
      .slice(0, limit)
      .map((call) => ({
        id: call.id,
        interactionId: call.interactionId,
        botKey: call.botKey,
        durationSeconds: call.durationSeconds,
        disposition: call.disposition,
        score: call.score,
        startedAt: call.startedAt,
        commitmentAmount: this.commitmentByInteraction.get(call.interactionId)?.amount ?? null,
      }));
  }

  async getCall(callId: string): Promise<CallDetail | null> {
    const call = [...this.calls.values()].find((row) => row.id === callId);
    if (!call) return null;

    return {
      call,
      turns: this.turnsByCall.get(callId) ?? [],
      violations: this.violationsByCall.get(callId) ?? [],
      commitments: [...this.commitmentByInteraction.values()].filter(
        (row) => row.interactionId === call.interactionId,
      ),
      escalations: this.escalations.filter((row) => row.interactionId === call.interactionId),
    };
  }

  /** Test and debugging surface; not part of the Store contract. */
  get toolCallCount(): number {
    return this.toolCalls.length;
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

let singleton: Store | null = null;

export function createStore(): Store {
  if (singleton) return singleton;

  const connectionString = process.env.DATABASE_URL;
  if (connectionString && connectionString.trim()) {
    singleton = createPostgresStore(connectionString);
  } else {
    singleton = new MemoryStore();
    console.warn(
      "[store] DATABASE_URL not set. Using in-memory storage: calls are lost on restart.",
    );
  }

  return singleton;
}
