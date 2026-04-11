#!/bin/sh
set -e

echo "Adding new enum values (if needed)..."
node -e "
const { Client } = require('pg');
(async () => {
  const c = new Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();
  await c.query(\"ALTER TYPE schedule_type ADD VALUE IF NOT EXISTS 'daily'\").catch(() => {});
  await c.query(\"ALTER TYPE schedule_type ADD VALUE IF NOT EXISTS 'monthly'\").catch(() => {});
  await c.end();
  console.log('Enum values checked.');
})().catch(e => { console.error('Enum update skipped:', e.message); });
" 2>&1

echo "Running database migrations..."
cd /app/lib/db
pnpm exec drizzle-kit push --force 2>&1 || echo "Migration warning (may be OK if schema is up to date)"

echo "Seeding default admin user..."
cd /app
pnpm --filter @workspace/scripts run seed 2>&1 || echo "Seed skipped (admin user may already exist)"

echo "Starting SSH Commander..."
exec "$@" 2>&1
