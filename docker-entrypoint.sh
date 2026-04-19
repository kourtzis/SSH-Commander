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
# already added the columns that matter. Push is for new tables / indexes.
pnpm exec drizzle-kit push --force 2>&1 || echo "drizzle-kit push warning (non-fatal — defensive ALTERs already applied)"

echo "Seeding default admin user..."
cd /app
pnpm --filter @workspace/scripts run seed 2>&1 || echo "Seed skipped (admin user may already exist)"

echo "Starting SSH Commander..."
exec "$@" 2>&1
