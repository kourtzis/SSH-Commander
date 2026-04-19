// ─── Credential Profile Routes ─────────────────────────────────────
// CRUD for reusable SSH credential profiles. Profiles can declare a jump
// host (bastion) — either as another credential profile (`jumpHostId`) or
// as inline host/port. Devices reference a profile via routers.credentialProfileId.
//
// Sensitive fields (sshPassword, enablePassword) are never returned in the
// list/detail responses — we expose only `hasPassword` / `hasEnablePassword`
// booleans so admins can see a profile is provisioned without leaking the
// secret to the browser.

import { Router, type IRouter } from "express";
import { db, credentialProfilesTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { requireAuth, requireAdmin, getCurrentUser } from "../lib/auth.js";

// Helper: requireAuth() returns void in this codebase, so resolve the actual
// user record from the session for any code path that needs role checks.
async function authedUser(req: any) {
  requireAuth(req);
  const u = await getCurrentUser(req);
  if (!u) {
    const err: any = new Error("Unauthorized");
    err.status = 401;
    throw err;
  }
  return u;
}

const router: IRouter = Router();

function sanitize(p: typeof credentialProfilesTable.$inferSelect) {
  return {
    id: p.id,
    name: p.name,
    sshUsername: p.sshUsername,
    hasPassword: !!p.sshPassword,
    hasEnablePassword: !!p.enablePassword,
    jumpHostId: p.jumpHostId,
    jumpHost: p.jumpHost,
    jumpPort: p.jumpPort,
    description: p.description,
    createdAt: p.createdAt,
  };
}

router.get("/credentials", async (req, res) => {
  const user = requireAuth(req);
  void user;
  const rows = await db.select().from(credentialProfilesTable).orderBy(credentialProfilesTable.name);
  res.json(rows.map(sanitize));
});

router.post("/credentials", async (req, res) => {
  const user = await authedUser(req);
  requireAdmin(user);
  const { name, sshUsername, sshPassword, enablePassword, jumpHostId, jumpHost, jumpPort, description } = req.body ?? {};
  if (!name || !sshUsername) {
    res.status(400).json({ error: "name and sshUsername are required" });
    return;
  }
  // Coerce empty strings (sent by HTML number inputs when blank) to null so
  // Postgres doesn't reject them with "invalid input syntax for type integer".
  const toIntOrNull = (v: unknown): number | null => {
    if (v === null || v === undefined || v === "") return null;
    const n = typeof v === "number" ? v : parseInt(String(v), 10);
    return Number.isFinite(n) ? n : null;
  };
  const toStrOrNull = (v: unknown): string | null => {
    if (v === null || v === undefined) return null;
    const s = String(v);
    return s.length === 0 ? null : s;
  };
  const [created] = await db
    .insert(credentialProfilesTable)
    .values({
      name, sshUsername,
      sshPassword: sshPassword || null,
      enablePassword: enablePassword || null,
      jumpHostId: toIntOrNull(jumpHostId),
      jumpHost: toStrOrNull(jumpHost),
      jumpPort: toIntOrNull(jumpPort),
      description: toStrOrNull(description),
    })
    .returning();
  res.status(201).json(sanitize(created));
});

router.put("/credentials/:id", async (req, res) => {
  const user = await authedUser(req);
  requireAdmin(user);
  const id = parseInt(req.params.id);
  const updates: Record<string, any> = {};
  const b = req.body ?? {};
  if (b.name !== undefined) updates.name = b.name;
  if (b.sshUsername !== undefined) updates.sshUsername = b.sshUsername;
  // Only update secrets if a non-empty string is provided. This lets the UI
  // omit the field to "leave unchanged" without forcing the operator to
  // re-enter passwords every edit.
  if (typeof b.sshPassword === "string" && b.sshPassword.length > 0) updates.sshPassword = b.sshPassword;
  if (typeof b.enablePassword === "string" && b.enablePassword.length > 0) updates.enablePassword = b.enablePassword;
  const toIntOrNull = (v: unknown): number | null => {
    if (v === null || v === undefined || v === "") return null;
    const n = typeof v === "number" ? v : parseInt(String(v), 10);
    return Number.isFinite(n) ? n : null;
  };
  const toStrOrNull = (v: unknown): string | null => {
    if (v === null || v === undefined) return null;
    const s = String(v);
    return s.length === 0 ? null : s;
  };
  if (b.jumpHostId !== undefined) updates.jumpHostId = toIntOrNull(b.jumpHostId);
  if (b.jumpHost !== undefined) updates.jumpHost = toStrOrNull(b.jumpHost);
  if (b.jumpPort !== undefined) updates.jumpPort = toIntOrNull(b.jumpPort);
  if (b.description !== undefined) updates.description = toStrOrNull(b.description);

  const [updated] = await db
    .update(credentialProfilesTable)
    .set(updates)
    .where(eq(credentialProfilesTable.id, id))
    .returning();
  if (!updated) {
    res.status(404).json({ error: "Profile not found" });
    return;
  }
  res.json(sanitize(updated));
});

router.delete("/credentials/:id", async (req, res) => {
  const user = await authedUser(req);
  requireAdmin(user);
  const id = parseInt(req.params.id);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid credential profile id" }); return; }
  await db.delete(credentialProfilesTable).where(eq(credentialProfilesTable.id, id));
  res.json({ message: "Credential profile deleted" });
});

export default router;
