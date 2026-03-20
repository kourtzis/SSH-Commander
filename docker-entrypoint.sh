#!/bin/sh
set -e

echo "Running database migrations..."
cd /app/lib/db
pnpm exec drizzle-kit push --force 2>&1 || echo "Migration warning (may be OK if schema is up to date)"

echo "Seeding default admin user..."
cd /app
pnpm --filter @workspace/scripts run seed 2>&1 || echo "Seed skipped (admin user may already exist)"

echo "Starting MikroManager..."
exec "$@"
