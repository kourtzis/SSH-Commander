// ─── Authentication Routes ──────────────────────────────────────────
// Session-based auth using express-session. Login validates credentials
// with bcrypt, stores userId in the session, and the session cookie
// is sent back to the client for subsequent requests.

import { Router, type IRouter } from "express";
import bcrypt from "bcryptjs";
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

  // Regenerate the session on login to defeat session-fixation:
  // an attacker who pre-set the victim's session cookie (e.g. via XSS on a
  // sister subdomain or a network-level injection) would otherwise share
  // the authenticated session. regenerate() issues a fresh session id and
  // discards the prior one before we attach the userId.
  await new Promise<void>((resolve, reject) => {
    req.session.regenerate((err) => (err ? reject(err) : resolve()));
  });
  (req.session as any).userId = user.id;
  await new Promise<void>((resolve, reject) => {
    req.session.save((err) => (err ? reject(err) : resolve()));
  });

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

// POST /auth/logout — Destroy the session AND clear the cookie.
// Without the explicit clearCookie, destroy() only wipes the row from the
// session store — the browser still holds the original session id cookie
// and would happily re-attach it to the next request, where the store
// would generate a brand-new empty session and silently re-issue the same
// id. clearCookie sends Set-Cookie with Max-Age=0 so the browser drops it
// immediately. Cookie attributes (path/sameSite/secure) MUST match the
// attributes express-session set when issuing the cookie or the browser
// ignores the clear request — so we mirror the exact same `cookieSecure`
// resolution app.ts uses (env override → default to NODE_ENV==="production").
const cookieSecureEnvLogout = process.env.COOKIE_SECURE?.toLowerCase();
const cookieSecureForLogout = cookieSecureEnvLogout === "true" ? true
  : cookieSecureEnvLogout === "false" ? false
  : process.env.NODE_ENV === "production";

router.post("/auth/logout", (req, res) => {
  req.session.destroy(() => {
    res.clearCookie("connect.sid", {
      path: "/",
      httpOnly: true,
      sameSite: "lax",
      secure: cookieSecureForLogout,
    });
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
