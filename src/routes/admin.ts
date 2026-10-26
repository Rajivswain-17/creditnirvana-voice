import { Router } from "express";
import { createStore } from "../db/store.js";
import { requireToolSecret } from "../lib/auth.js";

/**
 * Read-only surface for a reviewer: what happened, how it scored, what broke.
 * Not a product, just enough to prove the numbers are real.
 */
export const adminRouter = Router();

adminRouter.use("/admin", requireToolSecret());

adminRouter.get("/health", (_req, res) => {
  const store = createStore();
  res.json({
    ok: true,
    store: store.kind,
    uptime_seconds: Math.round(process.uptime()),
    node: process.version,
  });
});

adminRouter.get("/admin/calls", async (req, res) => {
  const store = createStore();
  const limit = Math.min(Number(req.query.limit ?? 50) || 50, 200);
  res.json({ calls: await store.listCalls(limit) });
});

adminRouter.get("/admin/calls/:id", async (req, res) => {
  const store = createStore();
  const detail = await store.getCall(req.params.id ?? "");
  if (!detail) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  res.json(detail);
});

adminRouter.get("/admin/summary", async (_req, res) => {
  const store = createStore();
  const calls = await store.listCalls(200);

  const durations = calls.map((call) => call.durationSeconds).filter((value) => value > 0);
  const scores = calls.map((call) => call.score).filter((value): value is number => value !== null);

  const dispositions: Record<string, number> = {};
  for (const call of calls) {
    const key = call.disposition ?? "unknown";
    dispositions[key] = (dispositions[key] ?? 0) + 1;
  }

  res.json({
    calls: calls.length,
    avg_duration_seconds: average(durations),
    avg_score: average(scores),
    commitments: calls.filter((call) => call.commitmentAmount !== null).length,
    committed_value: calls.reduce((total, call) => total + (call.commitmentAmount ?? 0), 0),
    dispositions,
  });
});

function average(values: number[]): number {
  if (values.length === 0) return 0;
  return Math.round((values.reduce((total, value) => total + value, 0) / values.length) * 10) / 10;
}
