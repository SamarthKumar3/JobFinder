import type { PoolClient } from "pg";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { pool } from "./db";
import { canonicalUrl, jobSchema } from "./domain";
import { fetchJobUrl } from "./job-url";
import { evaluate } from "./ai";
import { ingest, saveEvaluation } from "./workflow";
export const submissionSchema = z.object({
  url: z
    .url()
    .refine((u) => new URL(u).protocol === "https:", "Use an HTTPS job URL"),
  title: z.string().max(500).default(""),
  company: z.string().max(300).default(""),
  location: z.string().max(300).default(""),
  description: z.string().max(100000).default(""),
});
let active = false,
  wakeAgain = false;
export async function createSubmission(raw: unknown) {
  const input = submissionSchema.parse(raw);
  canonicalUrl(input.url);
  if (
    input.description &&
    (input.description.length < 50 ||
      !input.title.trim() ||
      !input.company.trim())
  )
    throw new Error(
      "Provide a title, company and at least 50 characters of job description.",
    );
  const id = randomUUID();
  await pool.query("INSERT INTO submissions(id,url,input) VALUES($1,$2,$3)", [
    id,
    input.url,
    input,
  ]);
  void drainSubmissions().catch((e) => console.error("URL worker:", e.message));
  return { id, state: "queued" };
}
export async function drainSubmissions() {
  if (active) {
    wakeAgain = true;
    return;
  }
  active = true;
  let client: PoolClient | undefined;
  let locked = false,
    broken = false;
  const onError = () => {
    broken = true;
  };
  try {
    client = await pool.connect();
    client.on("error", onError);
    locked = (
      await client.query("SELECT pg_try_advisory_lock(7284521) AS locked")
    ).rows[0].locked;
    if (!locked) return;
    await client.query(
      `UPDATE submissions SET state='queued' WHERE state='running'`,
    );
    do {
      wakeAgain = false;
      for (;;) {
        const task = (
          await client.query(
            `UPDATE submissions SET state='running' WHERE id=(SELECT id FROM submissions WHERE state='queued' ORDER BY created_at LIMIT 1) RETURNING *`,
          )
        ).rows[0];
        if (!task) break;
        let assignedJobId: string | undefined;
        try {
          const input = submissionSchema.parse(task.input);
          const extracted = input.description
            ? jobSchema.parse({
                title: input.title,
                company: input.company,
                location: input.location,
                description: input.description,
                source: "import",
                apply_url: input.url,
                metadata: { manual_url: true, user_pasted_description: true },
              })
            : await fetchJobUrl(input.url);
          const jobId = await ingest(extracted, true);
          assignedJobId = jobId;
          await client.query("UPDATE submissions SET job_id=$2 WHERE id=$1", [
            task.id,
            jobId,
          ]);
          const job = (
            await client.query("SELECT * FROM jobs WHERE id=$1", [jobId])
          ).rows[0];
          const evaluation = await evaluate(job, undefined, {
            timeout: 240000,
          });
          await saveEvaluation(client, job, evaluation);
          await client.query(
            `UPDATE submissions SET state='completed',error=NULL,finished_at=now() WHERE id=$1`,
            [task.id],
          );
        } catch (e) {
          if (broken) throw e;
          if (assignedJobId)
            await client.query(
              `UPDATE jobs SET state='error',error=$2 WHERE id=$1 AND state='pending'`,
              [assignedJobId, String(e)],
            );
          await client.query(
            `UPDATE submissions SET state='error',error=$2,finished_at=now() WHERE id=$1`,
            [task.id, String(e)],
          );
        }
      }
    } while (wakeAgain);
  } finally {
    client?.off("error", onError);
    try {
      if (locked && !broken && client)
        await client.query("SELECT pg_advisory_unlock(7284521)");
    } finally {
      client?.release(broken);
      active = false;
    }
  }
}
