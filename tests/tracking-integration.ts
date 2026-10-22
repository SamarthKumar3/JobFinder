import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import { migrate, pool } from "../server/db";
import { ingest } from "../server/workflow";
import { listJobs, querySchema } from "../server/jobs-query";
const marker = `Tracking QA ${randomUUID()}`;
const ids: string[] = [];
const input = (n: number) => ({
  title: "AI Software Engineer",
  company: marker,
  location: "Pune",
  source: "import",
  apply_url: `https://example.com/tracking/${marker}/${n}`,
  description:
    "Build Python and FastAPI applications with LLMs. Requires 1-2 years of experience.",
  metadata: { fixture: marker },
});
const list = (tab: string) =>
  listJobs(querySchema.parse({ tab, company: marker }));
try {
  await migrate();
  for (const n of [0, 1, 2]) ids.push(await ingest(input(n)));
  await pool.query(
    "UPDATE jobs SET state='evaluated',decision='apply',score=5,evaluated_at='2026-10-21T12:00:00Z' WHERE id=$1",
    [ids[0]],
  );
  await pool.query(
    "UPDATE jobs SET state='evaluated',decision='apply',score=4.1,evaluated_at='2026-10-22T12:00:00Z' WHERE id=$1",
    [ids[1]],
  );
  assert.deepEqual(
    (await list("all")).jobs.map((j) => j.id),
    [ids[1], ids[0], ids[2]],
  );
  await pool.query(
    "UPDATE jobs SET application_status='did_not_apply',application_status_updated_at=now() WHERE id=$1",
    [ids[1]],
  );
  assert.equal((await list("apply")).total, 1);
  assert.equal((await list("rejected")).jobs[0].id, ids[1]);
  await pool.query(
    "UPDATE jobs SET application_status='did_not_apply' WHERE id=$1",
    [ids[2]],
  );
  assert.equal((await list("pending")).total, 0);
  assert.equal((await list("rejected")).total, 2);
  await ingest(input(1));
  assert.equal(
    (await list("rejected")).jobs[0].application_status,
    "did_not_apply",
  );
  await ingest({
    ...input(1),
    description: input(1).description + " Additional Python responsibilities.",
  });
  const changed = (
    await pool.query(
      "SELECT application_status,evaluated_at FROM jobs WHERE id=$1",
      [ids[1]],
    )
  ).rows[0];
  assert.equal(changed.application_status, "did_not_apply");
  assert.equal(changed.evaluated_at, null);
  await pool.query("UPDATE jobs SET application_status='applied' WHERE id=$1", [
    ids[0],
  ]);
  assert.equal((await list("apply")).jobs[0].application_status, "applied");
  console.log(
    "Tracking integration passed: evaluation-time ordering, unevaluated dates, rejection override, status persistence through re-ingestion, and changed-content timestamp invalidation.",
  );
} finally {
  await pool.query(
    "DELETE FROM jobs WHERE id=ANY($1::uuid[]) AND metadata->>'fixture'=$2",
    [ids, marker],
  );
  await pool.end();
}
