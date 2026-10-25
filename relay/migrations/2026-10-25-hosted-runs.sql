-- Hosted runs (issue #15): each workspace's run minutes and each run's record. Additive; the same statements are in
-- schema.sql. Apply once per database: bunx wrangler@4.151.1 d1 execute overhand-relay-staging --remote --env staging --file migrations/2026-10-25-hosted-runs.sql
CREATE TABLE IF NOT EXISTS hosted_minutes (
  workspace TEXT PRIMARY KEY,
  balance INTEGER NOT NULL DEFAULT 0,
  month TEXT NOT NULL DEFAULT '',
  allowance_used INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS hosted_runs (
  id TEXT PRIMARY KEY,
  workspace TEXT NOT NULL,
  key TEXT NOT NULL,
  project TEXT NOT NULL,
  status TEXT NOT NULL,
  pr TEXT NOT NULL DEFAULT '',
  branch TEXT NOT NULL DEFAULT '',
  draft INTEGER NOT NULL DEFAULT 0,
  summary TEXT NOT NULL,
  minutes INTEGER NOT NULL,
  at INTEGER NOT NULL,
  seen INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS hosted_runs_workspace ON hosted_runs (workspace, at);
