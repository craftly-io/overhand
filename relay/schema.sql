-- The relay's D1 database: one entitlement per workspace, kept by Paddle webhooks, the webhook event ids seen, and the
-- revocation and TURN budget records. Every statement is additive and idempotent, so re-running this whole file is
-- the migration (see "Migrations" in README.md).
-- Apply: bunx wrangler@4.151.1 d1 execute overhand-relay --remote --file schema.sql
CREATE TABLE IF NOT EXISTS entitlements (
  workspace TEXT PRIMARY KEY,
  plan TEXT NOT NULL,
  cycle TEXT,
  seats INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL,
  subscription_id TEXT NOT NULL,
  customer_id TEXT NOT NULL,
  price_id TEXT NOT NULL,
  period_end TEXT,
  occurred_at TEXT NOT NULL,
  -- the cancel or pause Paddle makes at scheduled_at, or NULL (an existing database: migrations/2026-10-23-scheduled-change.sql)
  scheduled_change TEXT,
  scheduled_at TEXT
);
CREATE TABLE IF NOT EXISTS paddle_events (
  event_id TEXT PRIMARY KEY,
  received_at INTEGER NOT NULL
);
-- "Sign out everywhere": sessions of the workspace issued before not_before (ms) are void
CREATE TABLE IF NOT EXISTS session_epochs (
  workspace TEXT PRIMARY KEY,
  not_before INTEGER NOT NULL
);
-- "Unlink this computer": device keys whose link certificates the relay no longer accepts
CREATE TABLE IF NOT EXISTS revoked_links (
  pub TEXT PRIMARY KEY,
  workspace TEXT NOT NULL,
  revoked_at INTEGER NOT NULL
);
-- Computers linked to a workspace, by device public key: recorded when a daemon first asks for its entitlement, so
-- app.overhand.dev can tell a new account to install first (an unlinked key stays here, refused by revoked_links)
CREATE TABLE IF NOT EXISTS links (
  pub TEXT PRIMARY KEY,
  workspace TEXT NOT NULL,
  linked_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS links_workspace ON links (workspace);
-- TURN credential grants per workspace per month (YYYY-MM), for the budget cap
CREATE TABLE IF NOT EXISTS turn_grants (
  workspace TEXT NOT NULL,
  month TEXT NOT NULL,
  n INTEGER NOT NULL,
  PRIMARY KEY (workspace, month)
);
-- Teams (docs/teams.md). A team is a WorkOS organisation; D1 is the authority for who belongs and what they may do.
-- One team per person (team_members.user is the key). billing_ws is the workspace whose Team plan pays for the seats.
CREATE TABLE IF NOT EXISTS teams (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  billing_ws TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  -- when members first exceeded the plan's seats (ms), or NULL; members past the seats stop after the grace
  over_since INTEGER
);
CREATE TABLE IF NOT EXISTS team_members (
  user TEXT PRIMARY KEY,
  team TEXT NOT NULL,
  email TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'member')),
  joined_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS team_members_team ON team_members (team);
-- Invite links: only the SHA-256 of the link's secret is stored
CREATE TABLE IF NOT EXISTS team_invites (
  id TEXT PRIMARY KEY,
  team TEXT NOT NULL,
  email TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin', 'member')),
  by_user TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS team_invites_team ON team_invites (team);
-- Per-project owner and backup, by project name
CREATE TABLE IF NOT EXISTS team_projects (
  team TEXT NOT NULL,
  project TEXT NOT NULL,
  owner TEXT,
  backup TEXT,
  PRIMARY KEY (team, project)
);
-- The bounded catch-up log: durable feed events only (never presence), at most TEAM_LOG_KEEP per team
CREATE TABLE IF NOT EXISTS team_events (
  team TEXT NOT NULL,
  seq INTEGER NOT NULL,
  at INTEGER NOT NULL,
  body TEXT NOT NULL,
  PRIMARY KEY (team, seq)
);
-- Sign-in rate limits: tries per fixed window (win = the window's start, ms), keyed by a SHA-256 of what's counted
-- (never an email or address); the index keeps pruning old windows cheap
CREATE TABLE IF NOT EXISTS sign_in_limits (
  key TEXT NOT NULL,
  win INTEGER NOT NULL,
  n INTEGER NOT NULL,
  PRIMARY KEY (key, win)
);
CREATE INDEX IF NOT EXISTS sign_in_limits_win ON sign_in_limits (win);
