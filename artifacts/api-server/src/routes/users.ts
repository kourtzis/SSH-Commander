import { Router, type IRouter } from "express";
import bcrypt from "bcrypt";
import { db, usersTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { CreateUserBody, UpdateUserBody } from "@workspace/api-zod";
import { getCurrentUser, requireAuth, requireAdmin } from "../lib/auth.js";

const router: IRouter = Router();

function sanitizeUser(user: typeof usersTable.$inferSelect) {
  return {
    id: user.id,
    username: user.username,
    email: user.email,
    role: user.role,
    createdAt: user.createdAt,
  };
}

router.get("/users", async (req, res) => {
  requireAuth(req);
  const user = await getCurrentUser(req);
  requireAdmin(user!);
  const users = await db.select().from(usersTable).orderBy(usersTable.createdAt);
  res.json(users.map(sanitizeUser));
});

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

router.delete("/users/:id", async (req, res) => {
  requireAuth(req);
  const currentUser = await getCurrentUser(req);
  requireAdmin(currentUser!);

  const id = parseInt(req.params.id);
  await db.delete(usersTable).where(eq(usersTable.id, id));
  res.json({ message: "User deleted" });
});

export default router;
