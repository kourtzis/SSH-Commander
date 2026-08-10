// ─── API token routes ───────────────────────────────────────────────
// Everyone manages their own tokens; admins can additionally see (and
// revoke) everyone's via ?all=true. The plaintext token appears exactly
// once — in the 201 response — and only its sha256 lands in the DB.

import { Router, type IRouter } from "express";
import { db, apiTokensTable, usersTable } from "@workspace/db";
import { desc, eq } from "drizzle-orm";
import { CreateApiTokenBody } from "@workspace/api-zod";
import { requireAuth, getCurrentUser } from "../lib/auth.js";
import { generateApiToken } from "../lib/api-token-auth.js";
import { logAudit } from "../lib/audit.js";

const router: IRouter = Router();

const publicColumns = {
  id: apiTokensTable.id,
  userId: apiTokensTable.userId,
  name: apiTokensTable.name,
  prefix: apiTokensTable.prefix,
  scope: apiTokensTable.scope,
  lastUsedAt: apiTokensTable.lastUsedAt,
  expiresAt: apiTokensTable.expiresAt,
  revokedAt: apiTokensTable.revokedAt,
  createdAt: apiTokensTable.createdAt,
};

// GET /tokens — own tokens; admins may pass ?all=true.
router.get("/tokens", async (req, res) => {
  requireAuth(req);
  const user = await getCurrentUser(req);
  if (!user) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  const wantAll = String(req.query.all ?? "") === "true" && user.role === "admin";
  const rows = wantAll
    ? await db.select({ ...publicColumns, username: usersTable.username })
        .from(apiTokensTable)
        .leftJoin(usersTable, eq(apiTokensTable.userId, usersTable.id))
        .orderBy(desc(apiTokensTable.createdAt))
    : await db.select(publicColumns)
        .from(apiTokensTable)
        .where(eq(apiTokensTable.userId, user.id))
        .orderBy(desc(apiTokensTable.createdAt));
  res.json(rows);
});

// POST /tokens — create; plaintext returned once.
router.post("/tokens", async (req, res) => {
  requireAuth(req);
  const user = await getCurrentUser(req);
  if (!user) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  const parsed = CreateApiTokenBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request body" });
    return;
  }
  const { name, scope, expiresDays } = parsed.data;
  let expiresAt: Date | null = null;
  if (expiresDays !== undefined) {
    const days = Math.max(1, Math.min(3650, expiresDays));
    expiresAt = new Date(Date.now() + days * 24 * 60 * 60 * 1000);
  }
  const { token, hash, prefix } = generateApiToken();
  const [created] = await db.insert(apiTokensTable).values({
    userId: user.id,
    name,
    tokenHash: hash,
    prefix,
    scope,
    expiresAt,
  }).returning(publicColumns);
  void logAudit(req, "token.create", {
    resourceType: "api_token",
    resourceId: created.id,
    resourceName: name,
    details: { scope, expiresAt: expiresAt?.toISOString() ?? null },
  });
  res.status(201).json({ token, apiToken: { ...created, username: user.username } });
});

// DELETE /tokens/:id — revoke (owner or admin). Soft delete for audit.
router.delete("/tokens/:id", async (req, res) => {
  requireAuth(req);
  const user = await getCurrentUser(req);
  if (!user) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  const [row] = await db.select().from(apiTokensTable).where(eq(apiTokensTable.id, id)).limit(1);
  if (!row) {
    res.status(404).json({ error: "Token not found" });
    return;
  }
  if (row.userId !== user.id && user.role !== "admin") {
    res.status(403).json({ error: "You can only revoke your own tokens" });
    return;
  }
  if (!row.revokedAt) {
    await db.update(apiTokensTable).set({ revokedAt: new Date() }).where(eq(apiTokensTable.id, id));
  }
  void logAudit(req, "token.revoke", { resourceType: "api_token", resourceId: id, resourceName: row.name });
  res.json({ message: "Token revoked" });
});

export default router;
