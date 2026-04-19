#!/bin/sh
set -e

# ─── Schema bootstrap ────────────────────────────────────────────────
# We run two layers of migration to make upgrades from older versions
# (e.g. 1.4.1 → 1.7.x) bulletproof:
#
#   1. Explicit `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` for every
#      column added in 1.5.0 / 1.6.0 / 1.7.x. These are idempotent and
#      ALWAYS run, even if drizzle-kit push fails for any reason.
#
#   2. `drizzle-kit push --force` to catch any drift we didn't list
#      explicitly (new tables, indexes, etc.). If this fails we still
#      proceed — the explicit ALTERs above cover the columns that
#      actually break query execution.
#
# This avoids the 1.4.1 → 1.7.x upgrade failure where queries against
# routers.enable_password / credential_profile_id / vendor / os_version
# / last_fingerprint_at returned 500 because the columns were missing.

cd /app/lib/db

echo "Applying defensive schema migrations (idempotent)..."
node -e "
const { Client } = require('pg');
(async () => {
  const c = new Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();
  const stmts = [
    // ── enums (1.5+) ──────────────────────────────────────────────
    \"ALTER TYPE schedule_type ADD VALUE IF NOT EXISTS 'daily'\",
    \"ALTER TYPE schedule_type ADD VALUE IF NOT EXISTS 'monthly'\",
    // ── routers: 1.6.0 (credential profiles + fingerprinting) ─────
    \"ALTER TABLE routers ADD COLUMN IF NOT EXISTS enable_password text\",
    \"ALTER TABLE routers ADD COLUMN IF NOT EXISTS credential_profile_id integer\",
    \"ALTER TABLE routers ADD COLUMN IF NOT EXISTS vendor text\",
    \"ALTER TABLE routers ADD COLUMN IF NOT EXISTS os_version text\",
    \"ALTER TABLE routers ADD COLUMN IF NOT EXISTS last_fingerprint_at timestamp\",
    // ── batch_jobs: 1.5.0 (timeout + retry) ───────────────────────
    \"ALTER TABLE batch_jobs ADD COLUMN IF NOT EXISTS timeout_seconds integer NOT NULL DEFAULT 30\",
    \"ALTER TABLE batch_jobs ADD COLUMN IF NOT EXISTS retry_count integer NOT NULL DEFAULT 0\",
    \"ALTER TABLE batch_jobs ADD COLUMN IF NOT EXISTS retry_backoff_seconds integer NOT NULL DEFAULT 5\",
    // ── job_tasks: 1.5.0 (retry tracking) ─────────────────────────
    \"ALTER TABLE job_tasks ADD COLUMN IF NOT EXISTS attempt_count integer NOT NULL DEFAULT 0\",
    // ── routers: 1.8.0 (SSH host-key TOFU pinning) ────────────────
    \"ALTER TABLE routers ADD COLUMN IF NOT EXISTS ssh_host_key_fingerprint text\",
    // ── users: 1.8.0 (per-user terminal RBAC) ─────────────────────
    \"ALTER TABLE users ADD COLUMN IF NOT EXISTS can_terminal boolean NOT NULL DEFAULT false\",
    // ── new tables added in 1.5+ / 1.6+ / 1.7+ ────────────────────
    // We create these explicitly because drizzle-kit push's rename
    // detector will otherwise interactively ask whether each new table
    // is a rename of some existing table (e.g. 'session' from
    // connect-pg-simple), and even with --force the prompt blocks
    // container start. Creating them here means push has nothing new
    // to ask about.
    \"CREATE TABLE IF NOT EXISTS credential_profiles (\\
      id serial PRIMARY KEY,\\
      name text NOT NULL,\\
      ssh_username text NOT NULL,\\
      ssh_password text,\\
      enable_password text,\\
      jump_host_id integer,\\
      jump_host text,\\
      jump_port integer,\\
      description text,\\
      created_at timestamp NOT NULL DEFAULT now()\\
    )\",
    \"CREATE INDEX IF NOT EXISTS idx_credential_profiles_jump_host_id ON credential_profiles (jump_host_id)\",
    \"CREATE TABLE IF NOT EXISTS device_reachability (\\
      id serial PRIMARY KEY,\\
      router_id integer NOT NULL,\\
      day date NOT NULL,\\
      total_checks integer NOT NULL DEFAULT 0,\\
      success_count integer NOT NULL DEFAULT 0\\
    )\",
    \"CREATE INDEX IF NOT EXISTS idx_device_reachability_router_id ON device_reachability (router_id)\",
    \"CREATE UNIQUE INDEX IF NOT EXISTS uq_device_reachability_router_day ON device_reachability (router_id, day)\",
    \"CREATE TABLE IF NOT EXISTS saved_views (\\
      id serial PRIMARY KEY,\\
      user_id integer NOT NULL,\\
      page_key text NOT NULL,\\
      name text NOT NULL,\\
      view_state json NOT NULL DEFAULT '{}'::json,\\
      created_at timestamp NOT NULL DEFAULT now()\\
    )\",
    \"CREATE INDEX IF NOT EXISTS idx_saved_views_user_page ON saved_views (user_id, page_key)\",
  ];
  for (const sql of stmts) {
    try {
      await c.query(sql);
    } catch (e) {
      // 'duplicate_column' / 'already exists' / table-doesn't-exist-yet are all OK.
      // Anything else (e.g. permission denied) is logged but non-fatal.
      console.warn('  skip:', sql.slice(0, 80), '—', e.message);
    }
  }
  await c.end();
  console.log('Defensive migrations applied.');
})().catch(e => {
  console.error('Defensive migration failed (continuing):', e.message);
});
" 2>&1

echo "Running drizzle-kit push (catches any remaining schema drift)..."
# Don't fail container start on push errors — the defensive ALTERs above
# already added the columns and tables that matter. Push is here as a
# belt-and-braces catch for indexes / future schema drift.
#
# We pipe an empty stdin (`</dev/null`) so that if drizzle-kit ever asks
# an interactive question (e.g. its rename-detection prompt) it gets EOF
# immediately and exits non-zero rather than hanging the container start
# forever. The defensive block above already created every table that
# would trigger such a prompt.
pnpm exec drizzle-kit push --force </dev/null 2>&1 || echo "drizzle-kit push warning (non-fatal — defensive ALTERs already applied)"

echo "Seeding default admin user..."
cd /app
pnpm --filter @workspace/scripts run seed 2>&1 || echo "Seed skipped (admin user may already exist)"

echo "Starting SSH Commander..."
exec "$@" 2>&1
