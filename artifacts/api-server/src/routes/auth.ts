// ─── Authentication Routes ──────────────────────────────────────────
// Session-based auth using express-session. Login validates credentials
// with bcrypt, stores userId in the session, and the session cookie
// is sent back to the client for subsequent requests.
//
// TOTP (2FA) flow:
//   * login with password → if user.totpEnabled, we do NOT authenticate yet.
//     The session gets a `pendingUserId` and the response says totpRequired.
//   * POST /auth/totp/verify with the 6-digit code (or a recovery code)
//     completes the login: session is regenerated and userId attached.
//   * Enrollment: /auth/totp/setup (secret + QR) → /auth/totp/confirm (first
//     code proves the authenticator works) → recovery codes returned once.
//   * All TOTP management routes require a *session* — an API token must
//     never be able to enroll or disable 2FA.

import { Router, type IRouter } from "express";
import type { Request } from "express";
import bcrypt from "bcryptjs";
import { db, usersTable } from "@workspace/db";
import type { User } from "@workspace/db";
import { eq } from "drizzle-orm";
import { LoginBody, ConfirmTotpBody, VerifyTotpBody, DisableTotpBody } from "@workspace/api-zod";
import { getCurrentUser } from "../lib/auth.js";
import { encryptSecret, decryptSecret } from "@workspace/db";
import {
  generateTotpSecret,
  buildOtpauthUrl,
  buildQrDataUrl,
  verifyTotpCode,
  generateRecoveryCodes,
  consumeRecoveryCode,
  looksLikeRecoveryCode,
} from "../lib/totp.js";
import { logAuditAs, logAuditSystem } from "../lib/audit.js";

const router: IRouter = Router();

// The user shape returned by login/me. Never includes passwordHash,
// totpSecret, or recoveryCodes.
function publicUser(user: User) {
  return {
    id: user.id,
    username: user.username,
    email: user.email,
    role: user.role,
    canTerminal: user.canTerminal,
    totpEnabled: user.totpEnabled,
    createdAt: user.createdAt,
  };
}

function regenerateSession(req: Request): Promise<void> {
  return new Promise((resolve, reject) => {
    req.session.regenerate((err) => (err ? reject(err) : resolve()));
  });
}

function saveSession(req: Request): Promise<void> {
  return new Promise((resolve, reject) => {
    req.session.save((err) => (err ? reject(err) : resolve()));
  });
}

// Session-only guard for TOTP management. getCurrentUser also accepts API
// token identities, but 2FA enrollment/disable via a bearer token would let
// a leaked token weaken the account's own protection — so we insist on a
// real browser session here.
async function requireSessionUser(req: Request): Promise<User | null> {
  if (!(req.session as any)?.userId) return null;
  return getCurrentUser(req);
}

// POST /auth/login — Authenticate with username + password.
// Full success stores userId in the session and returns user info.
// If the account has 2FA enabled, returns { totpRequired: true } instead
// and parks the identity in session.pendingUserId until /auth/totp/verify.
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
    void logAuditSystem("auth.login_failed", { resourceType: "user", resourceName: username });
    res.status(401).json({ error: "Invalid credentials" });
    return;
  }

  const valid = await bcrypt.compare(password, user.passwordHash);
  if (!valid) {
    void logAuditAs(req, user, "auth.login_failed", {
      resourceType: "user", resourceId: user.id, resourceName: user.username,
    });
    res.status(401).json({ error: "Invalid credentials" });
    return;
  }

  // Regenerate the session on login to defeat session-fixation:
  // an attacker who pre-set the victim's session cookie (e.g. via XSS on a
  // sister subdomain or a network-level injection) would otherwise share
  // the authenticated session. regenerate() issues a fresh session id and
  // discards the prior one before we attach any identity — including the
  // *pending* identity, which is enough to finish login with a stolen phone.
  await regenerateSession(req);

  if (user.totpEnabled) {
    (req.session as any).pendingUserId = user.id;
    await saveSession(req);
    void logAuditAs(req, user, "auth.totp_challenge", {
      resourceType: "user", resourceId: user.id, resourceName: user.username,
    });
    res.json({ totpRequired: true, message: "Enter the code from your authenticator app" });
    return;
  }

  (req.session as any).userId = user.id;
  await saveSession(req);

  void logAuditAs(req, user, "auth.login", {
    resourceType: "user", resourceId: user.id, resourceName: user.username,
  });
  res.json({ user: publicUser(user), message: "Login successful" });
});

// POST /auth/totp/verify — Second step of login for 2FA accounts.
// Accepts a 6-digit TOTP code or a single-use recovery code (xxxxx-xxxxx).
// Rate-limited by authLimiter and CSRF-exempt (no authenticated session
// exists yet), both wired in app.ts.
router.post("/auth/totp/verify", async (req, res) => {
  const parsed = VerifyTotpBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request body" });
    return;
  }
  const pendingUserId = (req.session as any)?.pendingUserId;
  if (!pendingUserId) {
    res.status(401).json({ error: "No pending login — sign in with your password first" });
    return;
  }

  const [user] = await db
    .select()
    .from(usersTable)
    .where(eq(usersTable.id, pendingUserId))
    .limit(1);
  if (!user || !user.totpEnabled || !user.totpSecret) {
    // Account changed underneath the pending login (deleted, or 2FA reset
    // by an admin mid-flow). Force a fresh password login.
    delete (req.session as any).pendingUserId;
    res.status(401).json({ error: "Login expired — sign in again" });
    return;
  }

  const code = parsed.data.code.trim();
  let ok = false;
  if (looksLikeRecoveryCode(code)) {
    const remaining = consumeRecoveryCode(user.recoveryCodes ?? [], code);
    if (remaining) {
      ok = true;
      await db.update(usersTable).set({ recoveryCodes: remaining }).where(eq(usersTable.id, user.id));
      void logAuditAs(req, user, "auth.recovery_code_used", {
        resourceType: "user", resourceId: user.id, resourceName: user.username,
      });
    }
  } else {
    ok = verifyTotpCode(decryptSecret(user.totpSecret) ?? "", code);
  }

  if (!ok) {
    void logAuditAs(req, user, "auth.totp_failed", {
      resourceType: "user", resourceId: user.id, resourceName: user.username,
    });
    res.status(401).json({ error: "Invalid code" });
    return;
  }

  // Upgrade pending → authenticated. Regenerate again so the pre-auth
  // session id (which the network saw during the TOTP exchange) is retired.
  await regenerateSession(req);
  (req.session as any).userId = user.id;
  await saveSession(req);

  void logAuditAs(req, user, "auth.login", {
    resourceType: "user", resourceId: user.id, resourceName: user.username,
  });
  res.json({ user: publicUser(user), message: "Login successful" });
});

// POST /auth/totp/setup — Begin 2FA enrollment for the current user.
// Generates a secret (stored encrypted, NOT yet enabled) and returns the
// otpauth:// URL plus a QR data-URL. Enrollment only takes effect after
// /auth/totp/confirm proves the authenticator produces valid codes.
router.post("/auth/totp/setup", async (req, res) => {
  const user = await requireSessionUser(req);
  if (!user) {
    res.status(401).json({ error: "Not authenticated" });
    return;
  }
  if (user.totpEnabled) {
    res.status(400).json({ error: "Two-factor authentication is already enabled. Disable it first to re-enroll." });
    return;
  }

  const secret = generateTotpSecret();
  const otpauthUrl = buildOtpauthUrl(user.username, secret);
  const qrDataUrl = await buildQrDataUrl(otpauthUrl);

  await db
    .update(usersTable)
    .set({ totpSecret: encryptSecret(secret), totpEnabled: false, recoveryCodes: null })
    .where(eq(usersTable.id, user.id));

  res.json({ secret, otpauthUrl, qrDataUrl });
});

// POST /auth/totp/confirm — Complete enrollment with the first valid code.
// Returns the 10 recovery codes exactly once; only sha256 hashes are stored.
router.post("/auth/totp/confirm", async (req, res) => {
  const user = await requireSessionUser(req);
  if (!user) {
    res.status(401).json({ error: "Not authenticated" });
    return;
  }
  const parsed = ConfirmTotpBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request body" });
    return;
  }
  if (user.totpEnabled) {
    res.status(400).json({ error: "Two-factor authentication is already enabled" });
    return;
  }
  if (!user.totpSecret) {
    res.status(400).json({ error: "No enrollment in progress — call /auth/totp/setup first" });
    return;
  }

  if (!verifyTotpCode(decryptSecret(user.totpSecret) ?? "", parsed.data.code)) {
    res.status(400).json({ error: "Invalid code — check your authenticator app and try again" });
    return;
  }

  const { codes, hashes } = generateRecoveryCodes();
  await db
    .update(usersTable)
    .set({ totpEnabled: true, recoveryCodes: hashes })
    .where(eq(usersTable.id, user.id));

  void logAuditAs(req, user, "auth.totp_enabled", {
    resourceType: "user", resourceId: user.id, resourceName: user.username,
  });
  res.json({
    message: "Two-factor authentication enabled",
    recoveryCodes: codes,
  });
});

// POST /auth/totp/disable — Turn off 2FA. Requires the account password
// and, while 2FA is active, a valid TOTP or recovery code — a hijacked
// session alone must not be able to strip the account's protection.
router.post("/auth/totp/disable", async (req, res) => {
  const user = await requireSessionUser(req);
  if (!user) {
    res.status(401).json({ error: "Not authenticated" });
    return;
  }
  const parsed = DisableTotpBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request body" });
    return;
  }

  const validPassword = await bcrypt.compare(parsed.data.password, user.passwordHash);
  if (!validPassword) {
    res.status(401).json({ error: "Incorrect password" });
    return;
  }

  if (user.totpEnabled && user.totpSecret) {
    const code = (parsed.data.code ?? "").trim();
    let ok = false;
    if (code) {
      ok = looksLikeRecoveryCode(code)
        ? consumeRecoveryCode(user.recoveryCodes ?? [], code) !== null
        : verifyTotpCode(decryptSecret(user.totpSecret) ?? "", code);
    }
    if (!ok) {
      res.status(401).json({ error: "A valid authenticator or recovery code is required" });
      return;
    }
  }

  await db
    .update(usersTable)
    .set({ totpSecret: null, totpEnabled: false, recoveryCodes: null })
    .where(eq(usersTable.id, user.id));

  void logAuditAs(req, user, "auth.totp_disabled", {
    resourceType: "user", resourceId: user.id, resourceName: user.username,
  });
  res.json({ message: "Two-factor authentication disabled" });
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

router.post("/auth/logout", async (req, res) => {
  const user = await getCurrentUser(req).catch(() => null);
  if (user) {
    void logAuditAs(req, user, "auth.logout", {
      resourceType: "user", resourceId: user.id, resourceName: user.username,
    });
  }
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
  res.json(publicUser(user));
});

export default router;
