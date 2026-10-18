import test from "node:test";
import assert from "node:assert/strict";
import {
  canonicalUrl,
  recency,
  decision,
  evaluationSchema,
  filterClause,
} from "../server/domain";
import { publicIp } from "../server/company";
const base = {
  score: 4,
  recommendation: "apply" as const,
  summary: "Fit",
  strengths: [],
  gaps: [],
  blockers: [],
  confidence: "medium" as const,
  report: "Report",
};
test("strict apply threshold and blockers", () => {
  assert.equal(decision(base), "rejected");
  assert.equal(decision({ ...base, score: 4.01 }), "apply");
  assert.equal(
    decision({ ...base, score: 5, blockers: ["salary too low"] }),
    "rejected",
  );
  assert.equal(
    decision({ ...base, score: 5, recommendation: "reject" }),
    "rejected",
  );
  assert.equal(
    decision({ ...base, score: null, recommendation: "needs_confirmation" }),
    "review",
  );
});
test("reject invalid score; do not manufacture a default score", () => {
  for (const score of [0, 5.1, NaN, "5", null])
    assert.equal(evaluationSchema.safeParse({ ...base, score }).success, false);
});
test("canonical job identity preserves job ids and drops tracking", () => {
  assert.equal(
    canonicalUrl("https://example.com/job/1/?utm_source=x&jk=abc#apply"),
    "https://example.com/job/1?jk=abc",
  );
  assert.notEqual(
    canonicalUrl("https://example.com/jobs?jk=abc"),
    canonicalUrl("https://example.com/jobs?jk=def"),
  );
  assert.throws(() => canonicalUrl("javascript:alert(1)"));
});
test("filter construction accepts only supported tabs", () => {
  assert.match(filterClause("apply"), /decision='apply'/);
  assert.match(filterClause("rejected"), /decision='rejected'/);
  assert.throws(() => filterClause("'; DROP TABLE jobs;"));
});
test("company fetches reject private and metadata addresses", () => {
  for (const ip of [
    "127.0.0.1",
    "10.0.1.2",
    "169.254.169.254",
    "172.18.0.1",
    "192.168.1.1",
    "100.64.0.2",
    "::1",
    "::ffff:127.0.0.1",
  ])
    assert.equal(publicIp(ip), false, ip);
  assert.equal(publicIp("8.8.8.8"), true);
});

test("strict rolling 24-hour recency prevents historical and undated evaluations", () => {
  const now = Date.parse("2026-10-18T12:00:00Z");
  assert.equal(recency({ posted_at: "2026-10-17T12:00:00Z" }, now), "fresh");
  assert.equal(recency({ posted_at: "2026-10-17T11:59:59Z" }, now), "old");
  assert.equal(recency({ posted_at: "2026-08-18T11:59:59Z" }, now), "old");
  assert.equal(recency({ date_posted: "2026-10-18" }, now), "unknown");
  assert.equal(recency({}, now), "unknown");
  assert.equal(recency({ posted_at: "2027-01-01T00:00:00Z" }, now), "unknown");
});
