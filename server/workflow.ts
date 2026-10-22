import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { PoolClient } from "pg";
import { pool } from "./db";
import {
  jobSchema,
  recency,
  canonicalUrl,
  contentHash,
  decision,
  type IncomingJob,
  type Evaluation,
} from "./domain";
import { ROOT, searchConfig } from "./config";
import { runProcess } from "./process";
import { collectCompany, withSourceBudget } from "./company";
import { evaluate, resumeText } from "./ai";
import { screenJob, normalizedLocations } from "./screening";
import { canStartEvaluation, EVALUATION_TIMEOUT_MS } from "./workflow-budget";
export const WORKFLOW_LOCK = 7284519;
export async function ingest(raw: unknown, manual = false) {
  const j = jobSchema.parse(raw),
    hash = contentHash(j),
    url = canonicalUrl(j.apply_url);
  const screening = screenJob(
    j,
    (await searchConfig()).maxRequiredExperienceYears,
  );
  const { rows } = await pool.query(
    `INSERT INTO jobs(id,canonical_url,apply_url,title,company,location,source,description,metadata,content_hash,state,error,locations,manual,screening)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
    ON CONFLICT(canonical_url) DO UPDATE SET last_seen_at=now(),title=excluded.title,company=excluded.company,
    description=excluded.description,location=excluded.location,locations=excluded.locations,metadata=jobs.metadata||excluded.metadata,apply_url=excluded.apply_url,
    manual=jobs.manual OR excluded.manual,screening=excluded.screening,
    state=CASE WHEN NOT(excluded.manual OR jobs.manual) AND excluded.state='filtered' THEN 'filtered' WHEN jobs.content_hash<>excluded.content_hash OR jobs.state='filtered' THEN 'pending' ELSE jobs.state END,
    error=CASE WHEN NOT(excluded.manual OR jobs.manual) AND excluded.state='filtered' THEN excluded.error WHEN jobs.content_hash<>excluded.content_hash OR jobs.state='filtered' THEN NULL ELSE jobs.error END,
    attempts=CASE WHEN jobs.content_hash<>excluded.content_hash THEN 0 ELSE jobs.attempts END,
    score=CASE WHEN jobs.content_hash<>excluded.content_hash THEN NULL ELSE jobs.score END,
    decision=CASE WHEN jobs.content_hash<>excluded.content_hash THEN NULL ELSE jobs.decision END,
    evaluation=CASE WHEN jobs.content_hash<>excluded.content_hash THEN NULL ELSE jobs.evaluation END,
    evaluated_at=CASE WHEN jobs.content_hash<>excluded.content_hash THEN NULL ELSE jobs.evaluated_at END,
    content_hash=excluded.content_hash,updated_at=now() RETURNING id`,
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
      !manual && !screening.eligible ? "filtered" : "pending",
      !manual && !screening.eligible ? screening.reasons.join("; ") : null,
      normalizedLocations(j.location),
      manual,
      screening,
    ],
  );
  return rows[0].id as string;
}
export async function rescreenStoredJobs() {
  const max = (await searchConfig()).maxRequiredExperienceYears;
  const rows = (
    await pool.query(
      "SELECT id,title,description,location,metadata,manual,state FROM jobs",
    )
  ).rows;
  let filtered = 0;
  for (const j of rows) {
    const screening = screenJob(j, max);
    const reject = !j.manual && !screening.eligible;
    await pool.query(
      `UPDATE jobs SET locations=$2,screening=$3,state=CASE WHEN $4 THEN 'filtered' WHEN state='filtered' THEN 'pending' ELSE state END,error=CASE WHEN $4 THEN $5 WHEN state='filtered' THEN NULL ELSE error END WHERE id=$1`,
      [
        j.id,
        normalizedLocations(j.location),
        screening,
        reject,
        screening.reasons.join("; "),
      ],
    );
    if (reject) filtered++;
  }
  return { filtered };
}
export async function companyUrls() {
  const cfg = await searchConfig(),
    urls = [...cfg.companyUrls];
  try {
    await fs.access(path.join(ROOT, "companies.xlsx"));
    urls.push(
      ...JSON.parse(
        await runProcess(
          process.env.PYTHON_BIN || "python",
          ["scripts/companies.py", "companies.xlsx"],
          { cwd: ROOT, timeout: 10000 },
        ),
      ),
    );
  } catch (e: any) {
    if (e.code !== "ENOENT") throw e;
  }
  return [...new Set(urls)];
}
export async function reconcileWorkflowRuns() {
  const client = await pool.connect();
  let locked = false;
  try {
    locked = (
      await client.query("SELECT pg_try_advisory_lock($1) AS locked", [
        WORKFLOW_LOCK,
      ])
    ).rows[0].locked;
    if (locked)
      await client.query(
        `UPDATE runs SET state='interrupted',phase='interrupted',finished_at=now(),updated_at=now(),errors=errors||$1::jsonb WHERE state='running'`,
        [
          JSON.stringify([
            "Worker stopped before completing this run; no active workflow lock remains.",
          ]),
        ],
      );
  } finally {
    try {
      if (locked)
        await client.query("SELECT pg_advisory_unlock($1)", [WORKFLOW_LOCK]);
    } finally {
      client.release();
    }
  }
}
export async function saveEvaluation(
  client: PoolClient,
  job: any,
  result: Evaluation,
) {
  await client.query("BEGIN");
  try {
    await client.query(
      "INSERT INTO evaluations(job_id,result,content_hash) VALUES($1,$2,$3)",
      [job.id, result, job.content_hash],
    );
    await client.query(
      `UPDATE jobs SET state='evaluated',score=$2,decision=$3,evaluation=$4,error=NULL,evaluated_at=now(),updated_at=now() WHERE id=$1 AND content_hash=$5`,
      [job.id, result.score, decision(result), result, job.content_hash],
    );
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  }
}
export async function runWorkflow(trigger = "manual") {
  const client = await pool.connect(),
    id = randomUUID(),
    errors: string[] = [];
  const controller = new AbortController();
  let locked = false,
    disconnected = false,
    created = false;
  let discovered = 0,
    evaluated = 0,
    filtered = 0;
  const deadline = Date.now() + 30 * 60 * 1000;
  const timer = setTimeout(
    () =>
      controller.abort(new Error("Workflow reached its 30-minute time limit")),
    30 * 60 * 1000,
  );
  const onConnectionError = () => {
    disconnected = true;
    controller.abort(new Error("Workflow database connection was lost"));
  };
  client.on("error", onConnectionError);
  const check = () => {
    if (controller.signal.aborted || Date.now() >= deadline)
      throw new Error("Workflow interrupted or reached its time limit");
  };
  const phase = async (name: string) => {
    check();
    await client.query(
      "UPDATE runs SET phase=$2,discovered=$3,evaluated=$4,filtered=$5,errors=$6,updated_at=now() WHERE id=$1",
      [id, name, discovered, evaluated, filtered, JSON.stringify(errors)],
    );
  };
  const accept = async (raw: unknown) => {
    check();
    const j = jobSchema.parse(raw);
    if (recency(j.metadata) !== "fresh") return;
    const eligible = screenJob(
      j,
      (await searchConfig()).maxRequiredExperienceYears,
    ).eligible;
    await ingest(j);
    discovered++;
    if (!eligible) filtered++;
  };
  try {
    locked = (
      await client.query("SELECT pg_try_advisory_lock($1) AS locked", [
        WORKFLOW_LOCK,
      ])
    ).rows[0].locked;
    if (!locked)
      return { skipped: true, reason: "A workflow is already running" };
    await client.query(
      `UPDATE runs SET state='interrupted',phase='interrupted',finished_at=now(),updated_at=now() WHERE state='running'`,
    );
    if (
      trigger === "schedule" &&
      (
        await client.query(
          `SELECT id FROM runs WHERE trigger='schedule' AND (started_at AT TIME ZONE 'Asia/Kolkata')::date=(now() AT TIME ZONE 'Asia/Kolkata')::date AND state IN ('completed','partial')`,
        )
      ).rowCount
    )
      return { skipped: true, reason: "Scheduled workflow already ran today" };
    await client.query("INSERT INTO runs(id,trigger) VALUES($1,$2)", [
      id,
      trigger,
    ]);
    created = true;
    const cfg = await searchConfig();
    for (const site of cfg.sites) {
      await phase(`Collecting ${site}`);
      try {
        const payload = JSON.parse(
          await runProcess(
            process.env.PYTHON_BIN || "python",
            ["scripts/scrape.py"],
            {
              cwd: ROOT,
              input: JSON.stringify({ ...cfg, sites: [site] }),
              timeout: 180000,
              signal: controller.signal,
            },
          ),
        );
        errors.push(...payload.errors);
        for (const raw of payload.jobs) {
          try {
            await accept(raw);
          } catch (e) {
            errors.push(String(e));
          }
        }
      } catch (e) {
        errors.push(`${site}: ${String(e)}`);
      }
    }
    await phase("Collecting company jobs");
    const urls = await companyUrls();
    let cursor = 0;
    const companyDeadline = Math.min(deadline, Date.now() + 5 * 60 * 1000);
    await Promise.all(
      Array.from({ length: 3 }, async () => {
        while (
          cursor < urls.length &&
          !controller.signal.aborted &&
          Date.now() < companyDeadline
        ) {
          const url = urls[cursor++];
          try {
            for (const j of await withSourceBudget(
              () => collectCompany(url),
              Math.min(20000, companyDeadline - Date.now()),
              controller.signal,
            ))
              await accept(j);
          } catch (e) {
            errors.push(`${url}: ${String(e)}`);
          }
          await pool.query(
            "UPDATE runs SET discovered=$2,filtered=$3,errors=$4,updated_at=now() WHERE id=$1",
            [id, discovered, filtered, JSON.stringify(errors)],
          );
        }
      }),
    );
    if (cursor < urls.length)
      errors.push(
        `Company scan time limit: ${urls.length - cursor} portals deferred to a later run`,
      );
    await phase("Screening queued jobs");
    const rows = (
      await client.query(
        `SELECT * FROM jobs WHERE manual=false AND application_status IS NULL AND (state='pending' OR (state='error' AND attempts<3)) ORDER BY created_at DESC LIMIT 1000`,
      )
    ).rows;
    const eligible: any[] = [];
    for (const job of rows) {
      const screen = screenJob(job, cfg.maxRequiredExperienceYears);
      if (!screen.eligible) {
        await client.query(
          `UPDATE jobs SET state='filtered',screening=$2,error=$3 WHERE id=$1`,
          [job.id, screen, screen.reasons.join("; ")],
        );
        continue;
      }
      if (recency(job.metadata) !== "fresh") {
        await client.query(
          `UPDATE jobs SET state='skipped',error='Posting is outside the verified last 24 hours; not evaluated' WHERE id=$1`,
          [job.id],
        );
        continue;
      }
      eligible.push(job);
    }
    const limit = Math.max(
      1,
      Math.min(100, Number(process.env.MAX_EVALUATIONS_PER_RUN) || 30),
    );
    const cv = eligible.length ? await resumeText() : "";
    let attempted = 0;
    for (const [index, job] of eligible.slice(0, limit).entries()) {
      check();
      if (recency(job.metadata) !== "fresh") continue;
      if (!canStartEvaluation(deadline)) {
        errors.push(
          `Evaluation time budget reached: ${eligible.length - attempted} jobs remain queued. They will be checked for recency again before evaluation.`,
        );
        break;
      }
      await phase(
        `Evaluating ${index + 1}/${Math.min(eligible.length, limit)}: ${job.company}`,
      );
      await client.query("UPDATE jobs SET attempts=attempts+1 WHERE id=$1", [
        job.id,
      ]);
      attempted++;
      try {
        const result = await evaluate(job, cv, {
          signal: controller.signal,
          timeout: EVALUATION_TIMEOUT_MS,
        });
        await saveEvaluation(client, job, result);
        evaluated++;
      } catch (e) {
        errors.push(`Evaluation ${job.id}: ${String(e)}`);
        if (!disconnected)
          await client.query(
            `UPDATE jobs SET state='error',error=$2 WHERE id=$1`,
            [job.id, String(e)],
          );
      }
    }
    if (eligible.length > limit && attempted === limit)
      errors.push(
        `Evaluation limit reached: ${eligible.length - limit} jobs remain queued.`,
      );
    await phase("Finished");
    await client.query(
      `UPDATE runs SET state=$2,finished_at=now(),updated_at=now() WHERE id=$1`,
      [id, errors.length ? "partial" : "completed"],
    );
    return { id, discovered, evaluated, filtered, errors };
  } catch (e) {
    if (created && !disconnected)
      await client.query(
        `UPDATE runs SET state=$2,phase=$2,finished_at=now(),updated_at=now(),errors=$3 WHERE id=$1`,
        [
          id,
          controller.signal.aborted ? "timed_out" : "failed",
          JSON.stringify([...errors, String(e)]),
        ],
      );
    throw e;
  } finally {
    clearTimeout(timer);
    client.off("error", onConnectionError);
    try {
      if (locked && !disconnected)
        await client.query("SELECT pg_advisory_unlock($1)", [WORKFLOW_LOCK]);
    } finally {
      client.release(disconnected);
    }
  }
}
