// ─── Config backup routes ───────────────────────────────────────────
// Reading backups and running them is open to every authenticated user
// (operators already run arbitrary scripts via jobs — a config export is
// strictly less powerful). Deleting history and changing the automatic
// schedule are admin actions.

import { Router, type IRouter } from "express";
import { db, configBackupsTable } from "@workspace/db";
import { and, desc, eq, count } from "drizzle-orm";
import { RunBackupsBody, UpdateBackupSettingsBody } from "@workspace/api-zod";
import { requireAuth, requireAdminAuth, getCurrentUser } from "../lib/auth.js";
import { parsePagination } from "../lib/pagination.js";
import { resolveRouterIds } from "../lib/resolve-routers.js";
import { runBackupsForRouters } from "../lib/backups.js";
import { normalizeForCompare, computeConfigDiff } from "../lib/config-normalize.js";
import { getBackupSchedule, setSetting, BACKUP_SCHEDULE_KEY } from "../lib/app-settings.js";
import { logAudit } from "../lib/audit.js";

const router: IRouter = Router();

const metaColumns = {
  id: configBackupsTable.id,
  routerId: configBackupsTable.routerId,
  routerName: configBackupsTable.routerName,
  routerIp: configBackupsTable.routerIp,
  kind: configBackupsTable.kind,
  status: configBackupsTable.status,
  sizeBytes: configBackupsTable.sizeBytes,
  contentHash: configBackupsTable.contentHash,
  errorMessage: configBackupsTable.errorMessage,
  createdBy: configBackupsTable.createdBy,
  createdAt: configBackupsTable.createdAt,
  lastSeenAt: configBackupsTable.lastSeenAt,
};

// GET /backups — paged metadata (content deliberately excluded: exports can be large).
router.get("/backups", async (req, res) => {
  requireAuth(req);
  const page = parsePagination(req) ?? { limit: 50, offset: 0 };
  const conditions = [];
  const routerId = parseInt(String(req.query.routerId ?? ""), 10);
  if (!Number.isNaN(routerId)) conditions.push(eq(configBackupsTable.routerId, routerId));
  const kind = String(req.query.kind ?? "");
  if (kind === "manual" || kind === "scheduled" || kind === "pre_upgrade") {
    conditions.push(eq(configBackupsTable.kind, kind));
  }
  const where = conditions.length > 0 ? and(...conditions) : undefined;

  const [items, [{ value: total }]] = await Promise.all([
    db.select(metaColumns).from(configBackupsTable).where(where)
      .orderBy(desc(configBackupsTable.createdAt))
      .limit(page.limit).offset(page.offset),
    db.select({ value: count() }).from(configBackupsTable).where(where),
  ]);
  res.json({ items, total });
});

// POST /backups/run — kick off backups in the background; rows appear as devices finish.
router.post("/backups/run", async (req, res) => {
  requireAuth(req);
  const user = await getCurrentUser(req);
  const parsed = RunBackupsBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request body" });
    return;
  }
  const routerIds = parsed.data.routerIds ?? [];
  const groupIds = parsed.data.groupIds ?? [];
  const targets = await resolveRouterIds(routerIds, groupIds);
  if (targets.length === 0) {
    res.status(400).json({ error: "No routers targeted — pick at least one router or a non-empty group" });
    return;
  }
  void logAudit(req, "backup.run", {
    resourceType: "backup",
    details: { targeted: targets.length, routerIds, groupIds },
  });
  void runBackupsForRouters(targets, "manual", user?.id ?? null);
  res.status(202).json({ message: `Backing up ${targets.length} device(s) in the background`, targeted: targets.length });
});

// GET /backups/diff?fromId=&toId= — normalized unified diff between two backups.
router.get("/backups/diff", async (req, res) => {
  requireAuth(req);
  const fromId = parseInt(String(req.query.fromId ?? ""), 10);
  const toId = parseInt(String(req.query.toId ?? ""), 10);
  if (Number.isNaN(fromId) || Number.isNaN(toId)) {
    res.status(400).json({ error: "fromId and toId query parameters are required" });
    return;
  }
  const rows = await db.select().from(configBackupsTable)
    .where(and()) // placeholder to satisfy types; filtered below
    .then(() => Promise.all([
      db.select().from(configBackupsTable).where(eq(configBackupsTable.id, fromId)).limit(1),
      db.select().from(configBackupsTable).where(eq(configBackupsTable.id, toId)).limit(1),
    ]));
  const [[fromRow], [toRow]] = rows;
  if (!fromRow || !toRow) {
    res.status(404).json({ error: "One of the backups was not found" });
    return;
  }
  const fromNorm = normalizeForCompare(fromRow.content);
  const toNorm = normalizeForCompare(toRow.content);
  const result = computeConfigDiff(fromNorm, toNorm, {
    expected: `${fromRow.routerName} @ ${fromRow.createdAt.toISOString()}`,
    actual: `${toRow.routerName} @ ${toRow.createdAt.toISOString()}`,
  });
  res.json({
    fromId,
    toId,
    routerName: fromRow.routerId === toRow.routerId ? fromRow.routerName : null,
    addedLines: result.addedLines,
    removedLines: result.removedLines,
    identical: result.inSync,
    diff: result.diff,
  });
});

// GET /backups/settings — automatic backup schedule.
router.get("/backups/settings", async (req, res) => {
  requireAuth(req);
  res.json(await getBackupSchedule());
});

// PUT /backups/settings — admin: update schedule + retention.
router.put("/backups/settings", async (req, res) => {
  await requireAdminAuth(req);
  const parsed = UpdateBackupSettingsBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request body" });
    return;
  }
  const { enabled, timeOfDay, retentionPerRouter } = parsed.data;
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(timeOfDay)) {
    res.status(400).json({ error: "timeOfDay must be HH:MM (24h)" });
    return;
  }
  const retention = Math.max(1, Math.min(365, retentionPerRouter));
  const value = { enabled, timeOfDay, retentionPerRouter: retention };
  await setSetting(BACKUP_SCHEDULE_KEY, value);
  void logAudit(req, "settings.backup_update", { resourceType: "settings", details: value });
  res.json(value);
});

// GET /backups/:id — full backup including content.
router.get("/backups/:id", async (req, res) => {
  requireAuth(req);
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  const [row] = await db.select().from(configBackupsTable).where(eq(configBackupsTable.id, id)).limit(1);
  if (!row) {
    res.status(404).json({ error: "Backup not found" });
    return;
  }
  res.json(row);
});

// DELETE /backups/:id — admin.
router.delete("/backups/:id", async (req, res) => {
  await requireAdminAuth(req);
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  const [row] = await db.delete(configBackupsTable).where(eq(configBackupsTable.id, id))
    .returning({ id: configBackupsTable.id, routerName: configBackupsTable.routerName });
  if (!row) {
    res.status(404).json({ error: "Backup not found" });
    return;
  }
  void logAudit(req, "backup.delete", { resourceType: "backup", resourceId: id, resourceName: row.routerName });
  res.json({ message: "Backup deleted" });
});

export default router;
