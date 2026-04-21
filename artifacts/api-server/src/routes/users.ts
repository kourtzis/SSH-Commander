// ─── User Management Routes ─────────────────────────────────────────
// Admin-only CRUD for managing application users. All endpoints except
// GET /users/:id require the admin role. Passwords are hashed with bcrypt.

import { Router, type IRouter } from "express";
import bcrypt from "bcryptjs";
import { db, usersTable } from "@workspace/db";
import { eq, sql } from "drizzle-orm";
import { CreateUserBody, UpdateUserBody } from "@workspace/api-zod";
import { getCurrentUser, requireAuth, requireAdmin } from "../lib/auth.js";
import { parsePagination } from "../lib/pagination.js";

const router: IRouter = Router();

// Strip password hash from user records before sending to the client
function sanitizeUser(user: typeof usersTable.$inferSelect) {
  return {
    id: user.id,
    username: user.username,
    email: user.email,
    role: user.role,
    canTerminal: user.canTerminal,
    createdAt: user.createdAt,
  };
}

// GET /users — List all users (admin only)
router.get("/users", async (req, res) => {
  requireAuth(req);
  const user = await getCurrentUser(req);
  requireAdmin(user!);
  const page = parsePagination(req);
  if (page) {
    const [items, totalRow] = await Promise.all([
      db.select().from(usersTable).orderBy(usersTable.createdAt).limit(page.limit).offset(page.offset),
      db.select({ n: sql<number>`count(*)::int` }).from(usersTable),
    ]);
    res.json({
      items: items.map(sanitizeUser),
      total: totalRow[0]?.n ?? 0,
      limit: page.limit,
      offset: page.offset,
    });
    return;
  }
  const users = await db.select().from(usersTable).orderBy(usersTable.createdAt);
  res.json(users.map(sanitizeUser));
});

// POST /users — Create a new user (admin only). Password is bcrypt-hashed before storage.
router.post("/users", async (req, res) => {
  requireAuth(req);
  const currentUser = await getCurrentUser(req);
  requireAdmin(currentUser!);

  const parsed = CreateUserBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request body" });
    return;
  }

  const { username, email, password, role, canTerminal } = parsed.data as any;
  const passwordHash = await bcrypt.hash(password, 12);

  const [newUser] = await db
    .insert(usersTable)
    .values({ username, email, passwordHash, role, canTerminal: Boolean(canTerminal) })
    .returning();

  res.status(201).json(sanitizeUser(newUser));
});

// GET /users/:id — Get a single user by ID. Admin only — operators can only
// see their own record via /auth/me, not other users.
router.get("/users/:id", async (req, res) => {
  requireAuth(req);
  const currentUser = await getCurrentUser(req);
  requireAdmin(currentUser!);
  const id = parseInt(req.params.id);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid user id" }); return; }
  const [user] = await db
    .select()
    .from(usersTable)
    .where(eq(usersTable.id, id))
    .limit(1);
  if (!user) {
    res.status(404).json({ error: "User not found" });
    return;
  }
  res.json(sanitizeUser(user));
});

// PUT /users/:id — Update user fields (admin only). If password is provided, it's re-hashed.
router.put("/users/:id", async (req, res) => {
  requireAuth(req);
  const currentUser = await getCurrentUser(req);
  requireAdmin(currentUser!);

  const id = parseInt(req.params.id);
  const parsed = UpdateUserBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request body" });
    return;
  }

  const { username, email, password, role, canTerminal } = parsed.data as any;
  const updates: Record<string, any> = {};
  if (username !== undefined) updates.username = username;
  if (email !== undefined) updates.email = email;
  if (role !== undefined) updates.role = role;
  if (canTerminal !== undefined) updates.canTerminal = Boolean(canTerminal);
  if (password !== undefined) updates.passwordHash = await bcrypt.hash(password, 12);

  const [updated] = await db
    .update(usersTable)
    .set(updates)
    .where(eq(usersTable.id, id))
    .returning();

  if (!updated) {
    res.status(404).json({ error: "User not found" });
    return;
  }

  res.json(sanitizeUser(updated));
});

// DELETE /users/:id — Delete a user (admin only)
router.delete("/users/:id", async (req, res) => {
  requireAuth(req);
  const currentUser = await getCurrentUser(req);
  requireAdmin(currentUser!);

  const id = parseInt(req.params.id);
  await db.delete(usersTable).where(eq(usersTable.id, id));
  res.json({ message: "User deleted" });
});

export default router;
