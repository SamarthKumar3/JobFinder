import "dotenv/config";
import pg from "pg";
export const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  max: 8,
  connectionTimeoutMillis: 5000,
});
// Idle connections can emit errors when Docker restarts. Keep the HTTP server
// alive so pg can establish new connections after PostgreSQL recovers.
pool.on("error", (error) => {
  console.error("PostgreSQL connection interrupted:", error.message);
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
    ALTER TABLE jobs ADD COLUMN IF NOT EXISTS locations text[] NOT NULL DEFAULT '{}';
    ALTER TABLE jobs ADD COLUMN IF NOT EXISTS manual boolean NOT NULL DEFAULT false;
    ALTER TABLE jobs ADD COLUMN IF NOT EXISTS screening jsonb;
    ALTER TABLE jobs ADD COLUMN IF NOT EXISTS application_status text CHECK(application_status IN ('applied','did_not_apply'));
    ALTER TABLE jobs ADD COLUMN IF NOT EXISTS application_status_updated_at timestamptz;
    UPDATE jobs j SET evaluated_at=(SELECT max(e.created_at) FROM evaluations e WHERE e.job_id=j.id AND e.content_hash=j.content_hash)
      WHERE j.evaluated_at IS NULL AND j.state='evaluated';
    ALTER TABLE runs ADD COLUMN IF NOT EXISTS phase text NOT NULL DEFAULT 'starting';
    ALTER TABLE runs ADD COLUMN IF NOT EXISTS filtered integer NOT NULL DEFAULT 0;
    ALTER TABLE runs ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
    CREATE TABLE IF NOT EXISTS submissions (
      id uuid PRIMARY KEY,url text NOT NULL,state text NOT NULL DEFAULT 'queued',
      job_id uuid REFERENCES jobs(id),error text,created_at timestamptz NOT NULL DEFAULT now(),finished_at timestamptz
    );
    ALTER TABLE submissions ADD COLUMN IF NOT EXISTS input jsonb NOT NULL DEFAULT '{}';
    CREATE INDEX IF NOT EXISTS job_locations ON jobs USING gin(locations);
    CREATE UNIQUE INDEX IF NOT EXISTS active_artifact ON tasks(job_id,kind) WHERE state IN ('queued','running');
    CREATE INDEX IF NOT EXISTS jobs_score ON jobs(score DESC,created_at DESC);
    CREATE INDEX IF NOT EXISTS jobs_state ON jobs(state);
    CREATE INDEX IF NOT EXISTS jobs_evaluated ON jobs(evaluated_at DESC NULLS LAST,created_at DESC,id);
  `);
}
