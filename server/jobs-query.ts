import { z } from "zod";
import { filterClause } from "./domain";
import { pool } from "./db";
export const querySchema = z.object({
  tab: z.enum(["all", "apply", "rejected", "pending"]).default("apply"),
  q: z.string().max(200).default(""),
  company: z.string().max(300).default(""),
  role: z.string().max(400).default(""),
  location: z.string().max(300).default(""),
  offset: z.coerce.number().int().min(0).default(0),
});
export type JobQuery = z.infer<typeof querySchema>;
export function jobWhere(
  query: JobQuery,
  omit?: "company" | "role" | "location",
) {
  const values: unknown[] = [`%${query.q}%`];
  const parts = [
    `state <> 'filtered'`,
    `(${filterClause(query.tab)})`,
    `(title ILIKE $1 OR company ILIKE $1 OR location ILIKE $1)`,
  ];
  for (const key of ["company", "role", "location"] as const) {
    if (key === omit || !query[key]) continue;
    values.push(query[key]);
    parts.push(
      key === "location"
        ? `$${values.length} = ANY(locations)`
        : `${key === "role" ? "title" : key} = $${values.length}`,
    );
  }
  return { sql: parts.join(" AND "), values };
}
export async function listJobs(query: JobQuery) {
  const where = jobWhere(query);
  const result = await pool.query(
    `SELECT id,title,company,location,source,apply_url,score,decision,state,error,created_at FROM jobs WHERE ${where.sql} ORDER BY score DESC NULLS LAST,created_at DESC LIMIT 50 OFFSET $${where.values.length + 1}`,
    [...where.values, query.offset],
  );
  const total = (
    await pool.query(
      `SELECT count(*)::int AS n FROM jobs WHERE ${where.sql}`,
      where.values,
    )
  ).rows[0].n;
  const facets = await Promise.all(
    (["company", "role", "location"] as const).map(async (key) => {
      const f = jobWhere(query, key),
        expr =
          key === "role"
            ? "title"
            : key === "location"
              ? "facet_location"
              : "company";
      const from =
        key === "location"
          ? "jobs CROSS JOIN LATERAL unnest(locations) AS facet_location"
          : "jobs";
      const rows = (
        await pool.query(
          `SELECT ${expr} AS value,count(*)::int AS count FROM ${from} WHERE ${f.sql} AND ${expr}<>'' GROUP BY ${expr} ORDER BY lower(${expr}),${expr}`,
          f.values,
        )
      ).rows;
      return [key, rows] as const;
    }),
  );
  return { jobs: result.rows, total, filters: Object.fromEntries(facets) };
}
