// ─── Authentication Routes ──────────────────────────────────────────
// Session-based auth using express-session. Login validates credentials
// with bcrypt, stores userId in the session, and the session cookie
// is sent back to the client for subsequent requests.

import { Router, type IRouter } from "express";
import bcrypt from "bcrypt";
import { db, usersTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { LoginBody } from "@workspace/api-zod";
import { getCurrentUser } from "../lib/auth.js";

const router: IRouter = Router();

// POST /auth/login — Authenticate with username + password.
// On success, stores userId in the session and returns user info (no password hash).
router.post("/auth/login", async (req, res) => {
  const parsed = LoginBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request body" });
    return;
  }
  const { username, password } = parsed.data;

  const [user] = await db
    .select()
    .from(usersTable)
    .where(eq(usersTable.username, username))
    .limit(1);

  // Use the same error message for both "user not found" and "wrong password"
  // to prevent username enumeration attacks
  if (!user) {
    res.status(401).json({ error: "Invalid credentials" });
    return;
  }

  const valid = await bcrypt.compare(password, user.passwordHash);
  if (!valid) {
    res.status(401).json({ error: "Invalid credentials" });
    return;
  }

  // Persist the authenticated user's ID in the session
  (req.session as any).userId = user.id;

  res.json({
    user: {
      id: user.id,
      username: user.username,
      email: user.email,
      role: user.role,
      createdAt: user.createdAt,
    },
    message: "Login successful",
  });
});

// POST /auth/logout — Destroy the session and clear the cookie
router.post("/auth/logout", (req, res) => {
  req.session.destroy(() => {
    res.json({ message: "Logged out" });
  });
});

// GET /auth/me — Return the currently authenticated user (or 401 if not logged in).
// Used by the frontend on page load to restore the auth state.
router.get("/auth/me", async (req, res) => {
  const user = await getCurrentUser(req);
  if (!user) {
    res.status(401).json({ error: "Not authenticated" });
    return;
  }
  res.json({
    id: user.id,
    username: user.username,
    email: user.email,
    role: user.role,
    createdAt: user.createdAt,
  });
});

export default router;
