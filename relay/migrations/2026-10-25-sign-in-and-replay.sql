-- Issue #107: addresses that have signed in (their code sends get their own pool), and what's been used once (daemons'
-- request signatures, signed-out sessions). Additive; the same statements are in schema.sql. Apply once per database,
-- before deploying the Worker that reads them:
-- bunx wrangler@4.151.1 d1 execute overhand-relay-staging --remote --env staging --file migrations/2026-10-25-sign-in-and-replay.sql
-- bunx wrangler@4.151.1 d1 execute overhand-relay --remote --file migrations/2026-10-25-sign-in-and-replay.sql
CREATE TABLE IF NOT EXISTS sign_in_accounts (
  key TEXT PRIMARY KEY,
  at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS spent (
  key TEXT PRIMARY KEY,
  until INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS spent_until ON spent (until);
