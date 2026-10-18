import "dotenv/config";
import pg from "pg";
export const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  max: 8,
  connectionTimeoutMillis: 5000,
});
export async function migrate() {
  if (!process.env.DATABASE_URL) throw new Error("Set DATABASE_URL in .env");
  await pool.query(`
    CREATE TABLE IF NOT EXISTS jobs (
      id uuid PRIMARY KEY, canonical_url text NOT NULL UNIQUE, apply_url text NOT NULL,
      title text NOT NULL, company text NOT NULL, location text NOT NULL DEFAULT '',
      source text NOT NULL, description text NOT NULL, metadata jsonb NOT NULL DEFAULT '{}',
      content_hash text NOT NULL, state text NOT NULL DEFAULT 'pending',
      score numeric(3,2) CHECK(score >= 1 AND score <= 5), decision text,
      evaluation jsonb, error text, attempts integer NOT NULL DEFAULT 0,
      created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
      last_seen_at timestamptz NOT NULL DEFAULT now(), evaluated_at timestamptz
    );
    CREATE TABLE IF NOT EXISTS evaluations (
      id bigserial PRIMARY KEY, job_id uuid REFERENCES jobs(id), result jsonb NOT NULL,
      content_hash text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS runs (
      id uuid PRIMARY KEY, trigger text NOT NULL, state text NOT NULL DEFAULT 'running',
      discovered integer NOT NULL DEFAULT 0, evaluated integer NOT NULL DEFAULT 0,
      errors jsonb NOT NULL DEFAULT '[]', started_at timestamptz NOT NULL DEFAULT now(), finished_at timestamptz
    );
    CREATE TABLE IF NOT EXISTS tasks (
      id uuid PRIMARY KEY, job_id uuid REFERENCES jobs(id), kind text NOT NULL, state text NOT NULL DEFAULT 'queued',
      result jsonb, error text, created_at timestamptz NOT NULL DEFAULT now(), finished_at timestamptz
    );
    CREATE UNIQUE INDEX IF NOT EXISTS active_artifact ON tasks(job_id,kind) WHERE state IN ('queued','running');
    CREATE INDEX IF NOT EXISTS jobs_score ON jobs(score DESC,created_at DESC);
    CREATE INDEX IF NOT EXISTS jobs_state ON jobs(state);
  `);
}
