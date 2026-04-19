import { Request } from "express";
import { db, usersTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import type { User } from "@workspace/db";

// Extend express-session to store the authenticated user's ID
declare module "express-session" {
  interface SessionData {
    userId: number;
  }
}

// We cache the resolved user (and the in-flight Promise that resolves it)
// on the Request object itself, keyed by a Symbol so we don't collide with
// any other middleware that might use string keys. Several routes call
// `getCurrentUser(req)` followed by an admin check followed by
// `requireAuth(req)` — without this cache that would issue 2-3 identical
// `SELECT * FROM users WHERE id = ?` queries per request. The Request
// object is short-lived (one HTTP request) and garbage-collected when the
// response ends, so attaching cache state to it is safe and self-cleaning.
const CACHED_USER = Symbol("cachedUser");
interface RequestWithCache extends Request {
  [CACHED_USER]?: Promise<User | null>;
}

// Retrieve the full user record from the session cookie. Returns null if
// the session has no userId or the user no longer exists. The lookup is
// memoized per-request: repeat calls within the same HTTP request reuse
// the same DB query result.
export async function getCurrentUser(req: Request): Promise<User | null> {
  const r = req as RequestWithCache;
  if (r[CACHED_USER]) return r[CACHED_USER]!;
  const userId = (req.session as any)?.userId;
  if (!userId) {
    // Cache the negative result too so repeated calls on an unauthenticated
    // request don't keep checking the session.
    r[CACHED_USER] = Promise.resolve(null);
    return null;
  }
  // Cache the in-flight Promise (not the resolved value) so concurrent
  // callers within the same request await the same query rather than each
  // firing their own.
  r[CACHED_USER] = db
    .select()
    .from(usersTable)
    .where(eq(usersTable.id, userId))
    .limit(1)
    .then((rows) => rows[0] ?? null);
  return r[CACHED_USER]!;
}

// Guard: throws 401 if no session exists. Used at the top of every protected route.
export function requireAuth(req: Request): void {
  if (!(req.session as any)?.userId) {
    const err: any = new Error("Unauthorized");
    err.status = 401;
    throw err;
  }
}

// Guard: throws 403 if the user is not an admin. Used for user-management endpoints.
export function requireAdmin(user: User): void {
  if (user.role !== "admin") {
    const err: any = new Error("Forbidden");
    err.status = 403;
    throw err;
  }
}
