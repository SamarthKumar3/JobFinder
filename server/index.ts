import express from "express";
import path from "node:path";
import fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import cron from "node-cron";
import { CronExpressionParser } from "cron-parser";
import { z } from "zod";
import { DATA, ROOT, prepareDirectories, searchConfig } from "./config";
import { migrate, pool } from "./db";
import { filterClause, jobSchema } from "./domain";
import { ingest, runWorkflow, companyUrls } from "./workflow";
import { drainArtifacts } from "./documents";
const app = express();
app.disable("x-powered-by");
app.use((req, res, next) => {
  const host = req.headers.host?.split(":")[0];
  if (!["localhost", "127.0.0.1"].includes(host || ""))
    return res.status(403).json({ error: "Local access only" });
  if (!["GET", "HEAD", "OPTIONS"].includes(req.method)) {
    const origin = req.headers.origin;
    if (
      origin &&
      ![
        "http://127.0.0.1:4100",
        "http://localhost:4100",
        "http://127.0.0.1:5173",
        "http://localhost:5173",
      ].includes(origin)
    )
      return res.status(403).json({ error: "Cross-origin request denied" });
    if (req.headers["x-jobfinder-request"] !== "1")
      return res
        .status(403)
        .json({ error: "X-JobFinder-Request header required" });
  }
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  next();
});
app.use(express.json({ limit: "5mb" }));
const uuid = (value: unknown) => z.uuid().parse(value);
const schedule = process.env.SCHEDULE_CRON || "0 9 * * *",
  timezone = process.env.SCHEDULE_TIMEZONE || "Asia/Kolkata";
app.get("/api/health", async (_req, res) => {
  await pool.query("SELECT 1");
  res.json({ ok: true });
});
app.get("/api/status", async (_req, res) => {
  const counts = (
    await pool.query(`SELECT count(*)::int AS all,
    count(*) FILTER(WHERE state='evaluated' AND decision='apply')::int AS apply,
    count(*) FILTER(WHERE state='evaluated' AND decision='rejected')::int AS rejected,
    count(*) FILTER(WHERE state IN ('pending','error') OR decision='review')::int AS pending FROM jobs`)
  ).rows[0];
  const runs = (
    await pool.query("SELECT * FROM runs ORDER BY started_at DESC LIMIT 8")
  ).rows;
  res.json({
    counts,
    runs,
    nextRun: CronExpressionParser.parse(schedule, { tz: timezone })
      .next()
      .toISOString(),
    timezone,
    search: await searchConfig(),
    companyUrls: await companyUrls(),
  });
});
app.get("/api/jobs", async (req, res) => {
  const tab = z
      .enum(["apply", "rejected", "all", "pending"])
      .parse(req.query.tab || "apply"),
    q = String(req.query.q || "").slice(0, 200);
  const offset = z.coerce
    .number()
    .int()
    .min(0)
    .parse(req.query.offset || 0);
  const where = `(${filterClause(tab)}) AND (title ILIKE $1 OR company ILIKE $1 OR location ILIKE $1)`;
  const rows = (
    await pool.query(
      `SELECT id,title,company,location,source,apply_url,score,decision,state,error,created_at FROM jobs WHERE ${where} ORDER BY score DESC NULLS LAST,created_at DESC LIMIT 50 OFFSET $2`,
      [`%${q}%`, offset],
    )
  ).rows;
  const total = (
    await pool.query(`SELECT count(*)::int AS n FROM jobs WHERE ${where}`, [
      `%${q}%`,
    ])
  ).rows[0].n;
  res.json({ jobs: rows, total });
});
app.get("/api/jobs/:id", async (req, res) => {
  const job = (
    await pool.query("SELECT * FROM jobs WHERE id=$1", [uuid(req.params.id)])
  ).rows[0];
  if (!job) return res.status(404).json({ error: "Job not found" });
  const tasks = (
    await pool.query(
      "SELECT * FROM tasks WHERE job_id=$1 ORDER BY created_at DESC",
      [job.id],
    )
  ).rows;
  res.json({ ...job, tasks });
});
app.post("/api/jobs/import", async (req, res) => {
  const jobs = z.array(jobSchema).min(1).max(100).parse(req.body);
  const ids = [];
  for (const job of jobs) ids.push(await ingest(job));
  res.status(201).json({ ids });
});
app.post("/api/jobs/:id/retry", async (req, res) => {
  const result = await pool.query(
    `UPDATE jobs SET state='pending',attempts=0,error=NULL,score=NULL,decision=NULL WHERE id=$1 RETURNING id`,
    [uuid(req.params.id)],
  );
  if (!result.rowCount) return res.status(404).json({ error: "Job not found" });
  res.json({ queued: true });
});
app.post("/api/jobs/:id/confirm", async (req, res) => {
  const id = uuid(req.params.id),
    answer = z.string().trim().min(3).max(2000).parse(req.body.answer);
  const result = await pool.query(
    `UPDATE jobs SET metadata=jsonb_set(metadata,'{candidate_confirmation}',to_jsonb($2::text)),state='pending',attempts=0,score=NULL,decision=NULL,error=NULL WHERE id=$1 AND decision='review' RETURNING id`,
    [id, answer],
  );
  if (!result.rowCount)
    return res.status(409).json({ error: "Job is not awaiting confirmation" });
  res.json({ queued: true });
});
app.post("/api/run", (_req, res) => {
  void runWorkflow("manual").catch((e) =>
    console.error("Workflow failed:", e.message),
  );
  res.status(202).json({ accepted: true });
});
app.post("/api/jobs/:id/artifacts", async (req, res) => {
  const id = uuid(req.params.id),
    kind = z.enum(["resume", "cover"]).parse(req.body.kind);
  const job = (await pool.query("SELECT * FROM jobs WHERE id=$1", [id]))
    .rows[0];
  if (!job) return res.status(404).json({ error: "Job not found" });
  if (job.state !== "evaluated" || Number(job.score) < 2)
    return res
      .status(409)
      .json({ error: "Artifacts require a completed score of 2–5" });
  const row = (
    await pool.query(
      `INSERT INTO tasks(id,job_id,kind) VALUES($1,$2,$3) ON CONFLICT(job_id,kind) WHERE state IN ('queued','running') DO UPDATE SET kind=excluded.kind RETURNING *`,
      [randomUUID(), id, kind],
    )
  ).rows[0];
  void drainArtifacts().catch(console.error);
  res.status(202).json(row);
});
app.get("/api/tasks/:id/download", async (req, res) => {
  const task = (
    await pool.query(`SELECT * FROM tasks WHERE id=$1 AND state='completed'`, [
      uuid(req.params.id),
    ])
  ).rows[0];
  if (!task) return res.status(404).json({ error: "Artifact not ready" });
  const filename = path.basename(task.result.filename);
  res.download(
    path.join(DATA, "artifacts", filename),
    `Samarth_${task.kind}_${task.job_id.slice(0, 8)}.${task.kind === "resume" ? "pdf" : "docx"}`,
  );
});
app.use("/api", (_req, res) => {
  res.status(404).json({ error: "Unknown API route" });
});
app.use(express.static(path.join(ROOT, "dist")));
app.get("/{*path}", async (_req, res) => {
  try {
    await fs.access(path.join(ROOT, "dist/index.html"));
    res.sendFile(path.join(ROOT, "dist/index.html"));
  } catch {
    res.status(503).send("Run npm run build, or use npm run dev on port 5173.");
  }
});
app.use(
  (
    err: any,
    _req: express.Request,
    res: express.Response,
    _next: express.NextFunction,
  ) => {
    console.error(err.message);
    res
      .status(err instanceof z.ZodError ? 400 : 500)
      .json({
        error:
          err instanceof z.ZodError
            ? err.issues.map((i) => i.message).join("; ")
            : err.message,
      });
  },
);
await prepareDirectories();
await migrate();
cron.schedule(
  schedule,
  () => {
    void runWorkflow("schedule").catch(console.error);
  },
  { timezone },
);
const worker = setInterval(() => {
  void drainArtifacts().catch(console.error);
}, 5000);
void drainArtifacts().catch(console.error);
const server = app.listen(Number(process.env.PORT) || 4100, "127.0.0.1", () =>
  console.log("JobFinder: http://127.0.0.1:4100"),
);
process.on("SIGTERM", () => {
  clearInterval(worker);
  server.close(() => {
    void pool.end();
  });
});
