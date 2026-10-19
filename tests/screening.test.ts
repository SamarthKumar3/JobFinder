import test from "node:test";
import assert from "node:assert/strict";
import {
  screenJob,
  requiredExperience,
  normalizedLocations,
} from "../server/screening";
import { jobWhere, querySchema } from "../server/jobs-query";
import { extractJobPage } from "../server/job-url";
const job = {
  title: "AI Software Engineer",
  description:
    "Build Python, FastAPI and LLM applications with LangGraph. Required experience: 1-2 years. Full-time employment.",
  location: "Bengaluru, India",
  metadata: {},
};
test("pre-screen rejects unrelated search results even if they mention AI", () => {
  for (const title of [
    "Corporate Legal Counsel",
    "CA - Audit & Assurance",
    "Production Engineer",
    "Product Owner - AI Tools",
    "AI Sales Engineer",
  ])
    assert.equal(screenJob({ ...job, title }).eligible, false, title);
});
test("pre-screen rejects seniority and experience mismatches before evaluation", () => {
  for (const title of [
    "Senior AI Engineer",
    "Staff Software Engineer",
    "Lead Python Developer",
    "Principal ML Engineer",
    "Software Engineering Manager",
  ])
    assert.equal(screenJob({ ...job, title }).eligible, false, title);
  for (const description of [
    "Requires 15 to 19 years of experience in Python.",
    "Build Python applications. Minimum 5 years in production.",
    "Python skills, with at least three years of experience.",
  ])
    assert.equal(
      screenJob({ ...job, description }).eligible,
      false,
      description,
    );
  assert.equal(
    screenJob({ ...job, metadata: { experience_range: "15-19 Yrs" } }).eligible,
    false,
  );
});
test("pre-screen keeps relevant early-career jobs and ignores optional experience", () => {
  assert.equal(screenJob(job).eligible, true);
  assert.equal(
    screenJob({
      ...job,
      title: "Full Stack Developer",
      description:
        "React and TypeScript. 1.5 years of professional experience.",
    }).eligible,
    true,
  );
  assert.equal(
    requiredExperience("Python experience. 5 years of experience preferred."),
    null,
  );
  assert.equal(
    requiredExperience("Python. Up to 3 years of experience."),
    null,
  );
  assert.equal(
    screenJob({
      ...job,
      title: "AI Engineer",
      description: job.description + " We also welcome freshers.",
    }).eligible,
    true,
  );
});
test("pre-screen excludes non-full-time and fresher-only roles", () => {
  assert.equal(
    screenJob({ ...job, title: "Python Developer (Contract)" }).eligible,
    false,
  );
  assert.equal(
    screenJob({ ...job, metadata: { job_type: "internship" } }).eligible,
    false,
  );
  assert.equal(
    screenJob({ ...job, description: job.description + " Freshers only." })
      .eligible,
    false,
  );
});
test("locations preserve multi-city postings and NCR membership", () => {
  assert.deepEqual(normalizedLocations("Hybrid - Pune, Bengaluru"), [
    "Pune",
    "Bangalore",
  ]);
  assert.deepEqual(normalizedLocations("Gurgaon / Noida"), [
    "Gurugram",
    "Noida",
    "Delhi NCR",
  ]);
});
test("server-wide filters are parameterized and independent of page offsets", () => {
  const q = querySchema.parse({
    tab: "all",
    company: "x' OR TRUE--",
    role: "AI Engineer",
    location: "Bangalore",
    offset: "100",
  });
  const where = jobWhere(q);
  assert.equal(where.sql.includes(q.company), false);
  assert.ok(where.values.includes(q.company));
  assert.match(where.sql, /ANY\(locations\)/);
  assert.deepEqual(where, jobWhere({ ...q, offset: 0 }));
  assert.equal(jobWhere(q, "company").values.includes(q.company), false);
});
test("individual URL extraction obtains metadata without invoking AI", () => {
  const j = extractJobPage(
    "https://example.com/jobs/one",
    `<script type="application/ld+json">${JSON.stringify({ "@type": "JobPosting", title: "AI Software Engineer", description: "<p>Build Python FastAPI and LLM applications. This is a full-time role with 1-2 years of experience.</p>", hiringOrganization: { name: "Example" }, jobLocation: { address: { addressLocality: "Pune" } } })}</script>`,
  );
  assert.equal(j.title, "AI Software Engineer");
  assert.equal(j.company, "Example");
  assert.equal(j.location, "Pune");
  assert.equal(j.metadata.manual_url, true);
  assert.throws(
    () => extractJobPage("https://example.com/jobs", "<h1>Access denied</h1>"),
    /did not expose/,
  );
  const many = JSON.stringify([
    { "@type": "JobPosting" },
    { "@type": "JobPosting" },
  ]);
  assert.throws(
    () =>
      extractJobPage(
        "https://example.com/jobs",
        `<script type="application/ld+json">${many}</script>`,
      ),
    /multiple jobs/,
  );
});

test("parenthesized and plus-year requirements are blocked; ranges use their minimum", () => {
  assert.equal(
    requiredExperience("Proven experience (13+ years) in an AI Engineer role"),
    13,
  );
  assert.equal(
    screenJob({
      ...job,
      description:
        "Build Python applications. Proven experience (13+ years) in an AI Engineer role.",
    }).eligible,
    false,
  );
  assert.equal(
    requiredExperience("Python: 15+ years building software applications"),
    15,
  );
  assert.equal(requiredExperience("0 to 3 years of experience with Python"), 0);
  assert.equal(requiredExperience("1-2 years of experience"), 1);
});

test("disclosed low salaries and fresher-only bands are screened; unknown salary is retained", () => {
  assert.equal(
    screenJob({
      ...job,
      metadata: { currency: "INR", interval: "yearly", max_amount: 1900000 },
    }).eligible,
    false,
  );
  assert.equal(
    screenJob({
      ...job,
      metadata: { currency: "INR", interval: "yearly", max_amount: 2500000 },
    }).eligible,
    true,
  );
  assert.equal(
    screenJob({ ...job, metadata: { experience_range: "0-1 Yrs" } }).eligible,
    false,
  );
  assert.equal(
    screenJob({ ...job, metadata: { currency: "INR", max_amount: null } })
      .eligible,
    true,
  );
});
