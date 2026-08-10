#!/bin/sh
# 1.14.0 M-14: shell hygiene. -e: abort on any unhandled error;
# -u: abort on use of an unset variable (catches typos in env names);
# pipefail: a failure anywhere in a pipeline propagates instead of being
# swallowed by the success of the last stage. We deliberately keep /bin/sh
# (POSIX) so this works on minimal alpine-style base images.
set -e
set -u
# `pipefail` is a bash/dash extension; guard it so /bin/sh on truly minimal
# busybox doesn't blow up at parse time. Most modern container images
# (debian-slim, ubuntu, alpine 3.18+) have a sh that supports it.
( set -o pipefail 2>/dev/null ) && set -o pipefail || true

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
    // ── 2.0.0: enum types (DO blocks — CREATE TYPE has no IF NOT EXISTS) ──
    \"DO \$\$ BEGIN CREATE TYPE backup_kind AS ENUM ('manual','scheduled','pre_upgrade'); EXCEPTION WHEN duplicate_object THEN NULL; END \$\$\",
    \"DO \$\$ BEGIN CREATE TYPE backup_status AS ENUM ('success','failed'); EXCEPTION WHEN duplicate_object THEN NULL; END \$\$\",
    \"DO \$\$ BEGIN CREATE TYPE upgrade_run_status AS ENUM ('running','completed','failed','cancelled'); EXCEPTION WHEN duplicate_object THEN NULL; END \$\$\",
    \"DO \$\$ BEGIN CREATE TYPE upgrade_task_status AS ENUM ('pending','backing_up','upgrading','rebooting','verifying','success','failed','skipped'); EXCEPTION WHEN duplicate_object THEN NULL; END \$\$\",
    \"DO \$\$ BEGIN CREATE TYPE channel_type AS ENUM ('telegram','email','webhook'); EXCEPTION WHEN duplicate_object THEN NULL; END \$\$\",
    \"DO \$\$ BEGIN CREATE TYPE alert_event_status AS ENUM ('sent','failed','suppressed'); EXCEPTION WHEN duplicate_object THEN NULL; END \$\$\",
    \"DO \$\$ BEGIN CREATE TYPE api_token_scope AS ENUM ('read','write'); EXCEPTION WHEN duplicate_object THEN NULL; END \$\$\",
    // ── users: 2.0.0 (TOTP 2FA) ───────────────────────────────────
    \"ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_secret text\",
    \"ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_enabled boolean NOT NULL DEFAULT false\",
    \"ALTER TABLE users ADD COLUMN IF NOT EXISTS recovery_codes text[]\",
    // ── new tables added in 2.0.0 (same rationale as above: create
    // them here so drizzle-kit push never hits its rename prompt) ───
    \"CREATE TABLE IF NOT EXISTS config_backups (\
      id serial PRIMARY KEY,\
      router_id integer NOT NULL,\
      router_name text NOT NULL,\
      router_ip text NOT NULL,\
      kind backup_kind NOT NULL DEFAULT 'manual',\
      status backup_status NOT NULL DEFAULT 'success',\
      content text NOT NULL DEFAULT '',\
      content_hash text NOT NULL DEFAULT '',\
      size_bytes integer NOT NULL DEFAULT 0,\
      error_message text,\
      created_by integer,\
      created_at timestamptz NOT NULL DEFAULT now(),\
      last_seen_at timestamptz\
    )\",
    \"CREATE INDEX IF NOT EXISTS idx_config_backups_router_id ON config_backups (router_id)\",
    \"CREATE INDEX IF NOT EXISTS idx_config_backups_created_at ON config_backups (created_at)\",
    \"CREATE INDEX IF NOT EXISTS idx_config_backups_router_created ON config_backups (router_id, created_at)\",
    \"CREATE TABLE IF NOT EXISTS golden_configs (\
      id serial PRIMARY KEY,\
      group_id integer NOT NULL REFERENCES router_groups(id) ON DELETE CASCADE,\
      name text NOT NULL,\
      content text NOT NULL,\
      ignore_patterns text[] NOT NULL DEFAULT '{}',\
      updated_by integer,\
      created_at timestamptz NOT NULL DEFAULT now(),\
      updated_at timestamptz NOT NULL DEFAULT now()\
    )\",
    \"CREATE UNIQUE INDEX IF NOT EXISTS uq_golden_configs_group_id ON golden_configs (group_id)\",
    \"CREATE TABLE IF NOT EXISTS drift_results (\
      id serial PRIMARY KEY,\
      golden_config_id integer NOT NULL REFERENCES golden_configs(id) ON DELETE CASCADE,\
      router_id integer NOT NULL,\
      router_name text NOT NULL,\
      router_ip text NOT NULL,\
      backup_id integer,\
      in_sync boolean NOT NULL,\
      added_lines integer NOT NULL DEFAULT 0,\
      removed_lines integer NOT NULL DEFAULT 0,\
      diff text,\
      checked_at timestamptz NOT NULL DEFAULT now()\
    )\",
    \"CREATE UNIQUE INDEX IF NOT EXISTS uq_drift_results_golden_router ON drift_results (golden_config_id, router_id)\",
    \"CREATE INDEX IF NOT EXISTS idx_drift_results_router_id ON drift_results (router_id)\",
    \"CREATE TABLE IF NOT EXISTS upgrade_runs (\
      id serial PRIMARY KEY,\
      name text NOT NULL,\
      status upgrade_run_status NOT NULL DEFAULT 'running',\
      pre_backup boolean NOT NULL DEFAULT true,\
      total_tasks integer NOT NULL DEFAULT 0,\
      completed_tasks integer NOT NULL DEFAULT 0,\
      failed_tasks integer NOT NULL DEFAULT 0,\
      created_by integer,\
      created_at timestamptz NOT NULL DEFAULT now(),\
      completed_at timestamptz\
    )\",
    \"CREATE INDEX IF NOT EXISTS idx_upgrade_runs_status ON upgrade_runs (status)\",
    \"CREATE INDEX IF NOT EXISTS idx_upgrade_runs_created_at ON upgrade_runs (created_at)\",
    \"CREATE TABLE IF NOT EXISTS upgrade_tasks (\
      id serial PRIMARY KEY,\
      run_id integer NOT NULL REFERENCES upgrade_runs(id) ON DELETE CASCADE,\
      router_id integer NOT NULL,\
      router_name text NOT NULL,\
      router_ip text NOT NULL,\
      status upgrade_task_status NOT NULL DEFAULT 'pending',\
      old_version text,\
      new_version text,\
      log text NOT NULL DEFAULT '',\
      error_message text,\
      started_at timestamptz,\
      completed_at timestamptz\
    )\",
    \"CREATE INDEX IF NOT EXISTS idx_upgrade_tasks_run_id ON upgrade_tasks (run_id)\",
    \"CREATE TABLE IF NOT EXISTS notification_channels (\
      id serial PRIMARY KEY,\
      name text NOT NULL UNIQUE,\
      type channel_type NOT NULL,\
      config text NOT NULL,\
      enabled boolean NOT NULL DEFAULT true,\
      last_used_at timestamptz,\
      last_error text,\
      created_at timestamptz NOT NULL DEFAULT now()\
    )\",
    \"CREATE TABLE IF NOT EXISTS alert_rules (\
      id serial PRIMARY KEY,\
      name text NOT NULL UNIQUE,\
      event_types text[] NOT NULL,\
      router_ids integer[] NOT NULL DEFAULT '{}',\
      group_ids integer[] NOT NULL DEFAULT '{}',\
      channel_ids integer[] NOT NULL,\
      cooldown_minutes integer NOT NULL DEFAULT 5,\
      enabled boolean NOT NULL DEFAULT true,\
      created_at timestamptz NOT NULL DEFAULT now()\
    )\",
    \"CREATE TABLE IF NOT EXISTS alert_events (\
      id serial PRIMARY KEY,\
      rule_id integer,\
      rule_name text NOT NULL,\
      event_type text NOT NULL,\
      subject text NOT NULL,\
      message text NOT NULL,\
      status alert_event_status NOT NULL,\
      error text,\
      created_at timestamptz NOT NULL DEFAULT now()\
    )\",
    \"CREATE INDEX IF NOT EXISTS idx_alert_events_created_at ON alert_events (created_at)\",
    \"CREATE TABLE IF NOT EXISTS audit_log (\
      id serial PRIMARY KEY,\
      user_id integer,\
      username text NOT NULL,\
      action text NOT NULL,\
      resource_type text,\
      resource_id text,\
      resource_name text,\
      details jsonb,\
      ip text,\
      created_at timestamptz NOT NULL DEFAULT now()\
    )\",
    \"CREATE INDEX IF NOT EXISTS idx_audit_log_created_at ON audit_log (created_at)\",
    \"CREATE INDEX IF NOT EXISTS idx_audit_log_user_id ON audit_log (user_id)\",
    \"CREATE INDEX IF NOT EXISTS idx_audit_log_action ON audit_log (action)\",
    \"CREATE TABLE IF NOT EXISTS api_tokens (\
      id serial PRIMARY KEY,\
      user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,\
      name text NOT NULL,\
      token_hash text NOT NULL UNIQUE,\
      prefix text NOT NULL,\
      scope api_token_scope NOT NULL DEFAULT 'read',\
      last_used_at timestamptz,\
      expires_at timestamptz,\
      revoked_at timestamptz,\
      created_at timestamptz NOT NULL DEFAULT now()\
    )\",
    \"CREATE INDEX IF NOT EXISTS idx_api_tokens_user_id ON api_tokens (user_id)\",
    \"CREATE TABLE IF NOT EXISTS app_settings (\
      key text PRIMARY KEY,\
      value jsonb NOT NULL,\
      updated_at timestamptz NOT NULL DEFAULT now()\
    )\",
    // ── 2.0.0: trigram index for fleet-wide output search. Both are
    // best-effort: managed PG without superuser may refuse the
    // extension, and the app falls back to sequential ILIKE. ────────
    \"CREATE EXTENSION IF NOT EXISTS pg_trgm\",
    \"CREATE INDEX IF NOT EXISTS idx_job_tasks_output_trgm ON job_tasks USING gin (output gin_trgm_ops)\",
    // ── 1.13.0: orphan cleanup BEFORE adding FKs below ────────────
    // Adding FK constraints to existing tables fails if any row already
    // violates the constraint (orphaned join rows pointing at deleted
    // parents, etc.). Clean those up first so the FK creation in the
    // subsequent drizzle-kit push (or any future migration) succeeds.
    \"DELETE FROM job_tasks WHERE job_id NOT IN (SELECT id FROM batch_jobs)\",
    \"DELETE FROM schedules WHERE job_id NOT IN (SELECT id FROM batch_jobs)\",
    \"DELETE FROM group_routers WHERE group_id NOT IN (SELECT id FROM router_groups) OR router_id NOT IN (SELECT id FROM routers)\",
    \"DELETE FROM group_subgroups WHERE parent_group_id NOT IN (SELECT id FROM router_groups) OR child_group_id NOT IN (SELECT id FROM router_groups)\",
    \"DELETE FROM saved_views WHERE user_id NOT IN (SELECT id FROM users)\",
    \"DELETE FROM device_reachability WHERE router_id NOT IN (SELECT id FROM routers)\",
    \"UPDATE routers SET credential_profile_id = NULL WHERE credential_profile_id IS NOT NULL AND credential_profile_id NOT IN (SELECT id FROM credential_profiles)\",
    \"UPDATE credential_profiles SET jump_host_id = NULL WHERE jump_host_id IS NOT NULL AND jump_host_id NOT IN (SELECT id FROM credential_profiles)\",
    \"UPDATE router_groups SET parent_id = NULL WHERE parent_id IS NOT NULL AND parent_id NOT IN (SELECT id FROM router_groups)\",
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
#
# `--force` is dangerous: it accepts data-destroying changes (column
# drops, type changes, table renames mis-detected as drop+create) without
# confirmation. We gate it behind ALLOW_DESTRUCTIVE_MIGRATIONS=1 so that
# the default upgrade path uses plain `db:push`, which fails loudly on
# anything destructive instead of silently wiping data. Operators who
# WANT the legacy "always force" behaviour (e.g. CI deploys where the
# DB is disposable) can opt back in by setting the env var.
if [ "${ALLOW_DESTRUCTIVE_MIGRATIONS:-0}" = "1" ]; then
  echo "  ALLOW_DESTRUCTIVE_MIGRATIONS=1 — using --force (data-destroying changes will apply silently)."
  pnpm exec drizzle-kit push --force </dev/null 2>&1 || echo "drizzle-kit push warning (non-fatal — defensive ALTERs already applied)"
else
  pnpm exec drizzle-kit push </dev/null 2>&1 || echo "drizzle-kit push warning (non-fatal — defensive ALTERs already applied; set ALLOW_DESTRUCTIVE_MIGRATIONS=1 to allow destructive changes)"
fi

# 1.14.0 C-1: encrypt every legacy plaintext credential row with AES-256-GCM.
# Idempotent — already-encrypted rows pass through. Non-fatal on missing
# CREDENTIAL_ENCRYPTION_KEY in dev (the script logs and exits 0); fatal
# refusal happens earlier when the API server starts in production without
# the key.
echo "Encrypting credentials at rest (idempotent)..."
cd /app
pnpm --filter @workspace/scripts run encrypt-credentials 2>&1 || echo "Credential encryption migration skipped (non-fatal)"

echo "Seeding default admin user..."
pnpm --filter @workspace/scripts run seed 2>&1 || echo "Seed skipped (admin user may already exist)"

echo "Starting SSH Commander..."
exec "$@" 2>&1
