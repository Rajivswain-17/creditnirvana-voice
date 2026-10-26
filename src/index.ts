import "dotenv/config";
import express from "express";
import { BOT_KEYS } from "./config.js";
import { createStore } from "./db/store.js";
import { adminRouter } from "./routes/admin.js";
import { onStartRouter } from "./routes/on-start.js";
import { toolsRouter } from "./routes/tools.js";
import { webhookRouter } from "./routes/webhook.js";

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "2mb" }));

app.get("/", (_req, res) => {
  res.type("text/plain").send(
    [
      "CreditNirvana voice agent API",
      "",
      "  POST /on-start/:botKey              load caller variables at call start",
      "  POST /tools/:botKey/log-commitment  validate and record a commitment",
      "  POST /tools/:botKey/escalate        open a human ticket",
      "  POST /webhook/sarvam                ingest a finished call",
      "  GET  /health",
      "  GET  /admin/calls",
      "  GET  /admin/summary",
      "",
      `bots: ${BOT_KEYS.join(", ")}`,
    ].join("\n"),
  );
});

app.use("/on-start", onStartRouter);
app.use("/tools", toolsRouter);
app.use("/webhook", webhookRouter);
app.use(adminRouter);

app.use((_req, res) => {
  res.status(404).json({ error: "not_found" });
});

app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error("[error]", error);
  res.status(500).json({ error: "internal_error" });
});

const port = Number(process.env.PORT ?? 3000);

app.listen(port, () => {
  const store = createStore();
  console.warn(`[boot] listening on :${port} (store=${store.kind})`);
  if (store.kind === "memory") {
    console.warn("[boot] set DATABASE_URL to persist calls, commitments and audit findings");
  }
});

export { app };
