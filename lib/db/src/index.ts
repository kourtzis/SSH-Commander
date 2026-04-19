import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema";

const { Pool } = pg;

if (!process.env.DATABASE_URL) {
  throw new Error(
    "DATABASE_URL must be set. Did you forget to provision a database?",
  );
}

// Shared pg pool used by both Drizzle and the express-session store.
// The default pg.Pool max is 10, which is easy to exhaust on this app:
//   - Every authenticated /api request reads + touches the session (2 ops).
//   - Long-running SSH endpoints (fingerprint-all, per-device terminal,
//     interactive jobs) hold a request open for many seconds, during which
//     other requests pile up.
// When the pool runs out of connections, requests queue indefinitely (the
// default has no `connectionTimeoutMillis`). For the session store that
// looks like a silent read failure — express-session then treats the
// session as empty, the user appears logged out, and the operator gets
// "HTTP 401 Unauthorized" toasts mid-action.
//
// Bumping max to 20 and setting an explicit connection timeout makes the
// app robust to bursts of parallel SSH activity. The session store reuses
// this same pool (see app.ts) so session ops can't be starved by a separate
// internal connect-pg-simple pool.
export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 20,
  connectionTimeoutMillis: 10_000,
  idleTimeoutMillis: 30_000,
});
export const db = drizzle(pool, { schema });

export * from "./schema";
