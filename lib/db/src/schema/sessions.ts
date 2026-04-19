import { pgTable, varchar, json, timestamp, index } from "drizzle-orm/pg-core";

// Session table used by `connect-pg-simple` (express-session store).
//
// This table is OWNED by connect-pg-simple, not by our application code.
// We never read from it or write to it directly — express-session does
// that on every authenticated request. We declare it in the drizzle
// schema purely so that `drizzle-kit push --force` (which the docker
// entrypoint runs on every container start) sees the table as KNOWN
// and leaves it alone.
//
// Without this declaration, drizzle considered the `session` table an
// unmanaged stranger and silently dropped it on every container restart
// (with --force the prompt is suppressed). connect-pg-simple's
// `createTableIfMissing: true` then recreated it empty — so every
// container restart wiped every active session, the operator's cookie
// pointed at a sid that no longer existed, express-session generated
// a fresh empty session per request, and `requireAuth` rejected
// everything with 401 even though the cookie was perfectly valid.
//
// The shape below MUST exactly match what connect-pg-simple v10 creates
// (see node_modules/connect-pg-simple/table.sql) — same column names,
// types, primary key, and the expire-index. Mismatches would cause
// drizzle to issue ALTER statements on every push.
export const sessionTable = pgTable(
  "session",
  {
    sid: varchar("sid").primaryKey(),
    sess: json("sess").notNull(),
    expire: timestamp("expire", { precision: 6, withTimezone: false }).notNull(),
  },
  (t) => ({
    expireIdx: index("IDX_session_expire").on(t.expire),
  }),
);
