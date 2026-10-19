import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import { pool, migrate } from "../server/db";
import { ingest, reconcileWorkflowRuns } from "../server/workflow";
import { listJobs, querySchema } from "../server/jobs-query";
const marker = `JobFinder QA ${randomUUID()}`;
const ids: string[] = [];
const runId = randomUUID();
try {
  await migrate();
  const base = {
    title: "AI Engineer",
    company: marker,
    location: "Pune, Bengaluru",
    source: "import",
    description:
      "Build Python FastAPI and LLM applications. Full time, with 1-2 years of experience.",
    metadata: { fixture: marker },
  };
  for (let n = 0; n < 65; n++)
    ids.push(
      await ingest({
        ...base,
        title: n === 64 ? "Python Backend Developer" : "AI Engineer",
        apply_url: `https://example.com/${encodeURIComponent(marker)}/${n}`,
      }),
    );
  const listed = await listJobs(
    querySchema.parse({ tab: "all", company: marker }),
  );
  assert.equal(listed.jobs.length, 50);
  assert.equal(listed.total, 65);
  assert.equal(
    listed.filters.role.find((r: any) => r.value === "Python Backend Developer")
      ?.count,
    1,
  );
  const allCompany = listed.filters.company.find(
    (c: any) => c.value === marker,
  );
  assert.equal(allCompany.count, 65);
  const byRole = await listJobs(
    querySchema.parse({
      tab: "all",
      company: marker,
      role: "Python Backend Developer",
      location: "Bangalore",
    }),
  );
  assert.equal(byRole.total, 1);
  assert.equal(byRole.jobs[0].title, "Python Backend Developer");
  const legal = await ingest({
    ...base,
    title: "Corporate Legal Counsel",
    apply_url: `https://example.com/${encodeURIComponent(marker)}/legal`,
  });
  ids.push(legal);
  assert.equal(
    (await pool.query("SELECT state FROM jobs WHERE id=$1", [legal])).rows[0]
      .state,
    "filtered",
  );
  assert.equal(
    (await listJobs(querySchema.parse({ tab: "all", company: marker }))).total,
    65,
  );
  const senior = await ingest({
    ...base,
    description:
      "Build Python and AI agents, requiring 15 to 19 years of experience.",
    apply_url: `https://example.com/${encodeURIComponent(marker)}/senior`,
  });
  ids.push(senior);
  assert.equal(
    (await pool.query("SELECT state FROM jobs WHERE id=$1", [senior])).rows[0]
      .state,
    "filtered",
  );
  await pool.query(
    `INSERT INTO runs(id,trigger,state) VALUES($1,'integration','running')`,
    [runId],
  );
  await reconcileWorkflowRuns();
  assert.equal(
    (await pool.query("SELECT state FROM runs WHERE id=$1", [runId])).rows[0]
      .state,
    "interrupted",
  );
  console.log(
    "Integration passed: facets cover >50 jobs, exact cross-page filtering, multi-city membership, legal/senior jobs excluded, stale run recovery.",
  );
} finally {
  if (ids.length)
    await pool.query(
      "DELETE FROM jobs WHERE id=ANY($1::uuid[]) AND metadata->>'fixture'=$2",
      [ids, marker],
    );
  await pool.query(`DELETE FROM runs WHERE id=$1 AND trigger='integration'`, [
    runId,
  ]);
  await pool.end();
}
