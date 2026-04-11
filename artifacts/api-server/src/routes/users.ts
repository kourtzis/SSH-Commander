// ─── User Management Routes ─────────────────────────────────────────
// Admin-only CRUD for managing application users. All endpoints except
// GET /users/:id require the admin role. Passwords are hashed with bcrypt.

import { Router, type IRouter } from "express";
import bcrypt from "bcryptjs";
import { db, usersTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { CreateUserBody, UpdateUserBody } from "@workspace/api-zod";
import { getCurrentUser, requireAuth, requireAdmin } from "../lib/auth.js";

const router: IRouter = Router();

// Strip password hash from user records before sending to the client
function sanitizeUser(user: typeof usersTable.$inferSelect) {
  return {
    id: user.id,
    username: user.username,
    email: user.email,
    role: user.role,
    createdAt: user.createdAt,
  };
}

// GET /users — List all users (admin only)
router.get("/users", async (req, res) => {
  requireAuth(req);
  const user = await getCurrentUser(req);
  requireAdmin(user!);
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

  const { username, email, password, role } = parsed.data;
  const passwordHash = await bcrypt.hash(password, 10);

  const [newUser] = await db
    .insert(usersTable)
    .values({ username, email, passwordHash, role })
    .returning();

  res.status(201).json(sanitizeUser(newUser));
});

// GET /users/:id — Get a single user by ID
router.get("/users/:id", async (req, res) => {
  requireAuth(req);
  const id = parseInt(req.params.id);
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

  const { username, email, password, role } = parsed.data;
  const updates: Record<string, any> = {};
  if (username !== undefined) updates.username = username;
  if (email !== undefined) updates.email = email;
  if (role !== undefined) updates.role = role;
  if (password !== undefined) updates.passwordHash = await bcrypt.hash(password, 10);

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
