import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { pool } from "./db";
import {
  jobSchema,
  recency,
  canonicalUrl,
  contentHash,
  decision,
  type IncomingJob,
} from "./domain";
import { ROOT, searchConfig } from "./config";
import { runProcess } from "./process";
import { collectCompany } from "./company";
import { evaluate, resumeText } from "./ai";
export async function ingest(raw: unknown) {
  const j = jobSchema.parse(raw),
    hash = contentHash(j),
    url = canonicalUrl(j.apply_url);
  const { rows } = await pool.query(
    `INSERT INTO jobs(id,canonical_url,apply_url,title,company,location,source,description,metadata,content_hash)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
    ON CONFLICT(canonical_url) DO UPDATE SET last_seen_at=now(), title=excluded.title, company=excluded.company,
    description=excluded.description,location=excluded.location,metadata=excluded.metadata,apply_url=excluded.apply_url,
    state=CASE WHEN jobs.content_hash<>excluded.content_hash THEN 'pending' ELSE jobs.state END,
    attempts=CASE WHEN jobs.content_hash<>excluded.content_hash THEN 0 ELSE jobs.attempts END,
    score=CASE WHEN jobs.content_hash<>excluded.content_hash THEN NULL ELSE jobs.score END,
    decision=CASE WHEN jobs.content_hash<>excluded.content_hash THEN NULL ELSE jobs.decision END,
    content_hash=excluded.content_hash, updated_at=now() RETURNING id`,
    [
      randomUUID(),
      url,
      j.apply_url,
      j.title,
      j.company,
      j.location,
      j.source,
      j.description,
      j.metadata,
      hash,
    ],
  );
  return rows[0].id as string;
}
export async function companyUrls() {
  const cfg = await searchConfig(),
    urls = [...cfg.companyUrls];
  try {
    await fs.access(path.join(ROOT, "companies.xlsx"));
    const found = JSON.parse(
      await runProcess(
        process.env.PYTHON_BIN || "python",
        ["scripts/companies.py", "companies.xlsx"],
        { cwd: ROOT },
      ),
    );
    urls.push(...found);
  } catch (e: any) {
    if (e.code !== "ENOENT") throw e;
  }
  return [...new Set(urls)];
}
export async function runWorkflow(trigger = "manual") {
  const client = await pool.connect();
  const id = randomUUID();
  const errors: string[] = [];
  let discovered = 0,
    evaluated = 0;
  try {
    const lock = await client.query(
      "SELECT pg_try_advisory_lock(7284519) AS locked",
    );
    if (!lock.rows[0].locked)
      return { skipped: true, reason: "A workflow is already running" };
    await client.query(
      `UPDATE runs SET state='interrupted',finished_at=now() WHERE state='running'`,
    );
    if (trigger === "schedule") {
      const prior = await client.query(
        `SELECT id FROM runs WHERE trigger='schedule' AND (started_at AT TIME ZONE 'Asia/Kolkata')::date=(now() AT TIME ZONE 'Asia/Kolkata')::date AND state IN ('running','completed','partial')`,
      );
      if (prior.rowCount)
        return {
          skipped: true,
          reason: "Scheduled workflow already ran today",
        };
    }
    await client.query("INSERT INTO runs(id,trigger) VALUES($1,$2)", [
      id,
      trigger,
    ]);
    const cfg = await searchConfig();
    try {
      const payload = JSON.parse(
        await runProcess(
          process.env.PYTHON_BIN || "python",
          ["scripts/scrape.py"],
          { cwd: ROOT, input: JSON.stringify(cfg), timeout: 1200000 },
        ),
      );
      errors.push(...payload.errors);
      for (const job of payload.jobs) {
        try {
          if (recency(job.metadata) !== "fresh") {
            errors.push(
              "Job skipped: posting date outside the verified 24-hour window",
            );
            continue;
          }
          await ingest(job);
          discovered++;
        } catch (e) {
          errors.push(String(e));
        }
      }
    } catch (e) {
      errors.push(`Job boards: ${String(e)}`);
    }
    try {
      const urls = await companyUrls();
      let cursor = 0;
      await Promise.all(
        Array.from({ length: 3 }, async () => {
          while (cursor < urls.length) {
            const url = urls[cursor++];
            try {
              for (const j of await collectCompany(url)) {
                try {
                  if (recency(j.metadata) !== "fresh") {
                    errors.push(
                      `${url}: skipped old or unconfirmed-date posting`,
                    );
                    continue;
                  }
                  await ingest(j);
                  discovered++;
                } catch (e) {
                  errors.push(`${url}: ${String(e)}`);
                }
              }
            } catch (e) {
              errors.push(`${url}: ${String(e)}`);
            }
            await pool.query(
              "UPDATE runs SET discovered=$2,errors=$3 WHERE id=$1",
              [id, discovered, JSON.stringify(errors)],
            );
          }
        }),
      );
    } catch (e) {
      errors.push(`Company workbook: ${String(e)}`);
    }
    await client.query("UPDATE runs SET discovered=$2,errors=$3 WHERE id=$1", [
      id,
      discovered,
      JSON.stringify(errors),
    ]);
    const limit = Math.max(
      1,
      Math.min(100, Number(process.env.MAX_EVALUATIONS_PER_RUN) || 30),
    );
    const { rows } = await client.query(
      `SELECT * FROM jobs WHERE state='pending' OR (state='error' AND attempts<3) ORDER BY created_at DESC LIMIT 1000`,
      [],
    );
    const cv = rows.length ? await resumeText() : "";
    let attempted = 0;
    for (const job of rows) {
      const age = recency(job.metadata);
      if (age !== "fresh") {
        await client.query(
          `UPDATE jobs SET state='skipped',error=$2 WHERE id=$1`,
          [
            job.id,
            age === "old"
              ? "Posting is older than 24 hours; not evaluated"
              : "Exact posting date is unavailable; not evaluated",
          ],
        );
        continue;
      }
      if (attempted >= limit) break;
      attempted++;

      try {
        await client.query(`UPDATE jobs SET attempts=attempts+1 WHERE id=$1`, [
          job.id,
        ]);
        const result = await evaluate(job, cv);
        await client.query("BEGIN");
        await client.query(
          "INSERT INTO evaluations(job_id,result,content_hash) VALUES($1,$2,$3)",
          [job.id, result, job.content_hash],
        );
        await client.query(
          `UPDATE jobs SET state='evaluated',score=$2,decision=$3,evaluation=$4,error=NULL,evaluated_at=now(),updated_at=now() WHERE id=$1 AND content_hash=$5`,
          [job.id, result.score, decision(result), result, job.content_hash],
        );
        await client.query("COMMIT");
        evaluated++;
      } catch (e) {
        await client.query("ROLLBACK");
        errors.push(`Evaluation ${job.id}: ${String(e)}`);
        await client.query(
          `UPDATE jobs SET state='error',error=$2 WHERE id=$1`,
          [job.id, String(e)],
        );
      }
      await client.query("UPDATE runs SET evaluated=$2,errors=$3 WHERE id=$1", [
        id,
        evaluated,
        JSON.stringify(errors),
      ]);
    }
    await client.query(
      "UPDATE runs SET state=$2,finished_at=now(),errors=$3 WHERE id=$1",
      [id, errors.length ? "partial" : "completed", JSON.stringify(errors)],
    );
    return { id, discovered, evaluated, errors };
  } catch (e) {
    await client.query(
      `UPDATE runs SET state='failed',finished_at=now(),errors=$2 WHERE id=$1`,
      [id, JSON.stringify([...errors, String(e)])],
    );
    throw e;
  } finally {
    await client.query("SELECT pg_advisory_unlock(7284519)");
    client.release();
  }
}
