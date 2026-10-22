import test from "node:test";
import assert from "node:assert/strict";
import {
  collectWorkday,
  workdayBoard,
  WORKDAY_MAX_PAGES,
} from "../server/workday";
const url = "https://example.wd5.myworkdayjobs.com/en-US/External";
const now = Date.parse("2026-10-22T12:00:00Z");
const row = (n: number, postedOn = "Posted Today", title = "Recruiter") => ({
  title,
  externalPath: `/job/India/Role_${n}`,
  postedOn,
  locationsText: "India",
});
test("Workday scans later India pages instead of stopping after 20 global listings", async () => {
  const posts: any[] = [],
    details: string[] = [];
  const jobs = await collectWorkday(
    url,
    async (target, options) => {
      if (options?.method === "POST") {
        const body = JSON.parse(options.body!);
        posts.push(body);
        if (!body.appliedFacets.locationCountry)
          return JSON.stringify({
            total: 2000,
            facets: [
              {
                facetParameter: "locationCountry",
                values: [{ id: "IN", descriptor: "India" }],
              },
            ],
            jobPostings: Array.from({ length: 20 }, (_, n) => row(n)),
          });
        return JSON.stringify({
          total: 21,
          jobPostings:
            body.offset === 0
              ? Array.from({ length: 20 }, (_, n) => row(n))
              : [row(20, "Posted Today", "Python Engineer")],
        });
      }
      details.push(target);
      return JSON.stringify({
        jobPostingInfo: {
          title: "Python Engineer",
          location: "Pune, India",
          companyName: "Example",
          startDate: "2026-10-22T09:00:00Z",
          jobDescription:
            "Build Python and FastAPI applications with LLMs. Responsibilities include backend services and reliable software delivery.",
        },
      });
    },
    now,
  );
  assert.equal(jobs.length, 1);
  assert.equal(posts.length, 3);
  assert.deepEqual(posts[2].appliedFacets, { locationCountry: ["IN"] });
  assert.equal(posts[2].offset, 20);
  assert.equal(details.length, 1);
  assert.equal(jobs[0].metadata.posted_at, "2026-10-22T09:00:00Z");
});
test("Workday skips old detail pages and rejects unverifiable date-only timestamps", async () => {
  let detailCalls = 0;
  const jobs = await collectWorkday(
    url,
    async (_target, options) => {
      if (options?.method === "POST")
        return JSON.stringify({
          total: 2,
          jobPostings: [
            row(1, "Posted 60 Days Ago", "Python Engineer"),
            row(2, "Posted Today", "Python Engineer"),
          ],
        });
      detailCalls++;
      return JSON.stringify({
        jobPostingInfo: {
          startDate: "2026-10-22",
          jobDescription:
            "Python software development responsibilities. ".repeat(4),
        },
      });
    },
    now,
  );
  assert.equal(detailCalls, 1);
  assert.equal(jobs.length, 0);
  assert.match(jobs.diagnostics.join(" "), /without a verifiable timestamp/);
});
test("Workday stops on repeated pages and surfaces partial coverage", async () => {
  let calls = 0;
  const jobs = await collectWorkday(
    url,
    async () => {
      calls++;
      return JSON.stringify({
        total: 2000,
        jobPostings: Array.from({ length: 20 }, (_, n) => row(n)),
      });
    },
    now,
  );
  assert.equal(calls, 2);
  assert.match(jobs.diagnostics.join(" "), /repeated page/);
});
test("Workday uses finite page and time budgets without hiding truncation", async () => {
  let calls = 0;
  const jobs = await collectWorkday(
    url,
    async () => {
      const page = calls++;
      return JSON.stringify({
        total: 2000,
        jobPostings: Array.from({ length: 20 }, (_, n) => row(page * 20 + n)),
      });
    },
    now,
  );
  assert.equal(calls, WORKDAY_MAX_PAGES);
  assert.match(jobs.diagnostics.join(" "), /page safety limit/);
  const timed = await collectWorkday(
    url,
    async () => {
      throw Error("must not fetch");
    },
    now,
    () => false,
  );
  assert.match(timed.diagnostics.join(" "), /time budget/);
});
test("localized, filtered and job-detail Workday links share one board identity", () => {
  assert.equal(
    workdayBoard(url)?.key,
    workdayBoard(
      "https://example.wd5.myworkdayjobs.com/External/job/India/Role_1?country=IN",
    )?.key,
  );
  assert.equal(
    workdayBoard(url)?.key,
    workdayBoard(
      "https://example.wd5.myworkdayjobs.com/wday/cxs/example/External/jobs",
    )?.key,
  );
});
