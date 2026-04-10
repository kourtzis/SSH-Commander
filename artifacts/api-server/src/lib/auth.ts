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

// Retrieve the full user record from the session cookie.
// Returns null if the session has no userId or the user no longer exists.
export async function getCurrentUser(req: Request): Promise<User | null> {
  const userId = (req.session as any)?.userId;
  if (!userId) return null;
  const [user] = await db
    .select()
    .from(usersTable)
    .where(eq(usersTable.id, userId))
    .limit(1);
  return user ?? null;
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
