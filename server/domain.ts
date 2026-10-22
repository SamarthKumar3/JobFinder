import { createHash } from "node:crypto";
import { z } from "zod";
export const jobSchema = z.object({
  title: z.string().min(1),
  company: z.string().min(1),
  location: z.string().default(""),
  source: z.enum(["linkedin", "indeed", "naukri", "company", "import"]),
  apply_url: z.url(),
  description: z.string().min(50).max(100000),
  metadata: z.record(z.string(), z.unknown()).default({}),
});
export type IncomingJob = z.infer<typeof jobSchema>;
export const evaluationSchema = z
  .object({
    score: z.number().min(1).max(5).multipleOf(0.01).nullable(),
    recommendation: z.enum(["apply", "reject", "needs_confirmation"]),
    summary: z.string(),
    strengths: z.array(z.string()),
    gaps: z.array(z.string()),
    blockers: z.array(z.string()),
    confidence: z.enum(["low", "medium", "high"]),
    report: z.string(),
  })
  .superRefine((v, ctx) => {
    if (
      v.recommendation === "needs_confirmation"
        ? v.score !== null
        : v.score === null
    )
      ctx.addIssue({
        code: "custom",
        message:
          "Confirmation gates require null score; completed evaluations require a score",
      });
  });
export type Evaluation = z.infer<typeof evaluationSchema>;
export function decision(e: Evaluation) {
  return e.recommendation === "needs_confirmation"
    ? "review"
    : e.score !== null &&
        e.score > 4 &&
        e.recommendation === "apply" &&
        e.blockers.length === 0
      ? "apply"
      : "rejected";
}
export function canonicalUrl(raw: string) {
  const u = new URL(raw);
  if (!["http:", "https:"].includes(u.protocol) || u.username || u.password)
    throw new Error("Use an http(s) job URL without credentials");
  u.hash = "";
  for (const key of [...u.searchParams.keys()])
    if (/^(utm_|trk|trackingId|refId|ref|source)/i.test(key))
      u.searchParams.delete(key);
  u.searchParams.sort();
  u.pathname = u.pathname.replace(/\/$/, "") || "/";
  return u.toString();
}
export function contentHash(j: IncomingJob) {
  return createHash("sha256")
    .update(JSON.stringify([j.title, j.company, j.description]))
    .digest("hex");
}
export function filterClause(tab: string) {
  const clauses: Record<string, string> = {
    all: "TRUE",
    apply:
      "state='evaluated' AND decision='apply' AND application_status IS DISTINCT FROM 'did_not_apply'",
    rejected:
      "application_status='did_not_apply' OR (state='evaluated' AND decision='rejected')",
    pending:
      "(state IN ('pending','error') OR decision='review') AND application_status IS DISTINCT FROM 'did_not_apply'",
  };
  if (!clauses[tab]) throw new Error("Unknown tab");
  return clauses[tab];
}

export function recency(
  metadata: Record<string, any>,
  now = Date.now(),
): "fresh" | "old" | "unknown" {
  const raw =
    metadata.posted_at ??
    metadata.postedAt ??
    metadata.datePosted ??
    metadata.publishedAt ??
    metadata.createdAt;
  if (raw == null || raw === "") return "unknown";
  // Date-only values do not prove an exact rolling 24-hour age.
  if (typeof raw === "string" && !/[T ]\d{2}:\d{2}/.test(raw)) return "unknown";
  const stamp =
    typeof raw === "number" ? (raw < 1e12 ? raw * 1000 : raw) : Date.parse(raw);
  if (!Number.isFinite(stamp) || stamp > now) return "unknown";
  return stamp >= now - 86400000 ? "fresh" : "old";
}
