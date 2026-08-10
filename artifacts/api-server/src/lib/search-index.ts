// ─── Full-text-ish search index for job outputs ─────────────────────
// Best-effort: pg_trgm turns our ILIKE '%needle%' output search from a
// sequential scan into a GIN trigram lookup. If the extension isn't
// available (locked-down Postgres), we log and move on — the search
// endpoint works either way, just slower on big fleets.

import { pool } from "@workspace/db";
import { childLogger } from "./logger.js";

const log = childLogger("search-index");

export async function ensureOutputSearchIndex(): Promise<void> {
  try {
    await pool.query("CREATE EXTENSION IF NOT EXISTS pg_trgm");
    // CONCURRENTLY: never blocks writes on an existing busy table. Must be
    // its own statement outside a transaction — pool.query does exactly that.
    await pool.query(
      "CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_job_tasks_output_trgm ON job_tasks USING gin (output gin_trgm_ops)",
    );
    log.info("pg_trgm output search index ready");
  } catch (err) {
    log.warn({ err }, "pg_trgm unavailable — output search will fall back to sequential ILIKE scans");
  }
}
