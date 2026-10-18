import "dotenv/config";
import fs from "node:fs/promises";
import { pool, migrate } from "../server/db";
import { ingest } from "../server/workflow";
import { randomUUID } from "node:crypto";
const prefix = `https://example.com/jobfinder-integration-${randomUUID()}`;
try {
  await migrate();
  const job = {
    title: "AI Engineer",
    company: "Integration fixture",
    location: "Pune",
    source: "import",
    apply_url: prefix,
    description:
      "Build Python FastAPI LLM applications and reliable production agent orchestration services.",
    metadata: {},
  };
  const first = await ingest(job),
    second = await ingest({ ...job, apply_url: prefix + "?utm_source=test" });
  if (first !== second) throw new Error("Deduplication failed");
  await pool.query(
    `UPDATE jobs SET state='evaluated',score=4.5,decision='apply' WHERE id=$1`,
    [first],
  );
  await ingest(job);
  if (
    (await pool.query("SELECT state FROM jobs WHERE id=$1", [first])).rows[0]
      .state !== "evaluated"
  )
    throw new Error("Unchanged descriptions must retain evaluations");
  await ingest({
    ...job,
    description: job.description + " Updated qualifications.",
  });
  const changed = (
    await pool.query("SELECT state,score FROM jobs WHERE id=$1", [first])
  ).rows[0];
  if (changed.state !== "pending" || changed.score !== null)
    throw new Error("Changed descriptions must be rescored");
  console.log(
    "PostgreSQL integration: dedup, unchanged retention, changed-content invalidation passed.",
  );
} finally {
  await pool.query("DELETE FROM jobs WHERE canonical_url LIKE $1", [
    prefix + "%",
  ]);
  await pool.end();
}
