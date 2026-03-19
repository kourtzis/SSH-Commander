import { Request } from "express";
import { db, usersTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import type { User } from "@workspace/db";

declare module "express-session" {
  interface SessionData {
    userId: number;
  }
}

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

export function requireAuth(req: Request): void {
  if (!(req.session as any)?.userId) {
    const err: any = new Error("Unauthorized");
    err.status = 401;
    throw err;
  }
}

export function requireAdmin(user: User): void {
  if (user.role !== "admin") {
    const err: any = new Error("Forbidden");
    err.status = 403;
    throw err;
  }
}
