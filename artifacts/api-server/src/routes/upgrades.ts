// ─── RouterOS upgrade routes ────────────────────────────────────────
// Starting/cancelling/deleting runs is admin-only — this reboots
// production gear. Reading is open to all authenticated users.

import { Router, type IRouter } from "express";
import { db, routersTable, upgradeRunsTable, upgradeTasksTable } from "@workspace/db";
import { desc, eq, inArray } from "drizzle-orm";
import { CreateUpgradeRunBody } from "@workspace/api-zod";
import { requireAuth, requireAdminAuth } from "../lib/auth.js";
import { resolveRouterIds } from "../lib/resolve-routers.js";
import { startUpgradeRun } from "../lib/upgrade-runner.js";
import { logAudit } from "../lib/audit.js";

const router: IRouter = Router();

// GET /upgrades/overview — fleet grouped by fingerprinted version.
router.get("/upgrades/overview", async (req, res) => {
  requireAuth(req);
  const routers = await db.select({
    id: routersTable.id,
    name: routersTable.name,
    ipAddress: routersTable.ipAddress,
    model: routersTable.model,
    vendor: routersTable.vendor,
    osVersion: routersTable.osVersion,
    lastFingerprintAt: routersTable.lastFingerprintAt,
  }).from(routersTable).orderBy(routersTable.name);

  const groups = new Map<string, { osVersion: string | null; vendor: string | null; routers: typeof routers }>();
  for (const r of routers) {
    const key = `${r.vendor ?? ""}|${r.osVersion ?? ""}`;
    if (!groups.has(key)) groups.set(key, { osVersion: r.osVersion, vendor: r.vendor, routers: [] });
    groups.get(key)!.routers.push(r);
  }
  const out = [...groups.values()]
    .map((g) => ({
      osVersion: g.osVersion,
      vendor: g.vendor,
      count: g.routers.length,
      routers: g.routers.map(({ id, name, ipAddress, model, lastFingerprintAt }) => ({ id, name, ipAddress, model, lastFingerprintAt })),
    }))
    // Known versions first (newest-looking string sort desc), unfingerprinted last.
    .sort((a, b) => {
      if (a.osVersion === null && b.osVersion === null) return 0;
      if (a.osVersion === null) return 1;
      if (b.osVersion === null) return -1;
      return b.osVersion.localeCompare(a.osVersion, undefined, { numeric: true });
    });
  res.json(out);
});

// GET /upgrades — runs, newest first.
router.get("/upgrades", async (req, res) => {
  requireAuth(req);
  const runs = await db.select().from(upgradeRunsTable).orderBy(desc(upgradeRunsTable.createdAt)).limit(100);
  res.json(runs);
});

// POST /upgrades — admin: create + start a run.
router.post("/upgrades", async (req, res) => {
  const user = await requireAdminAuth(req);
  const parsed = CreateUpgradeRunBody.safeParse(req.body);
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
  const targetRouters = await db.select().from(routersTable).where(inArray(routersTable.id, targets));
  const name = parsed.data.name?.trim() || `Upgrade ${new Date().toISOString().slice(0, 16).replace("T", " ")}`;
  const preBackup = parsed.data.preBackup ?? true;

  const [run] = await db.insert(upgradeRunsTable).values({
    name,
    status: "running",
    preBackup,
    totalTasks: targetRouters.length,
    createdBy: user.id,
  }).returning();

  await db.insert(upgradeTasksTable).values(targetRouters.map((r) => ({
    runId: run.id,
    routerId: r.id,
    routerName: r.name,
    routerIp: r.ipAddress,
    status: "pending" as const,
    oldVersion: r.osVersion ?? null,
  })));

  void logAudit(req, "upgrade.start", {
    resourceType: "upgrade_run",
    resourceId: run.id,
    resourceName: name,
    details: { devices: targetRouters.length, preBackup },
  });
  void startUpgradeRun(run.id);
  res.status(201).json(run);
});

// GET /upgrades/:id — run + tasks.
router.get("/upgrades/:id", async (req, res) => {
  requireAuth(req);
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  const [run] = await db.select().from(upgradeRunsTable).where(eq(upgradeRunsTable.id, id)).limit(1);
  if (!run) {
    res.status(404).json({ error: "Upgrade run not found" });
    return;
  }
  const tasks = await db.select().from(upgradeTasksTable)
    .where(eq(upgradeTasksTable.runId, id))
    .orderBy(upgradeTasksTable.id);
  res.json({ ...run, tasks });
});

// POST /upgrades/:id/cancel — admin: skip everything still pending.
router.post("/upgrades/:id/cancel", async (req, res) => {
  await requireAdminAuth(req);
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  const [run] = await db.select().from(upgradeRunsTable).where(eq(upgradeRunsTable.id, id)).limit(1);
  if (!run) {
    res.status(404).json({ error: "Upgrade run not found" });
    return;
  }
  if (run.status !== "running") {
    res.status(400).json({ error: `Run is already ${run.status}` });
    return;
  }
  const [updated] = await db.update(upgradeRunsTable)
    .set({ status: "cancelled" })
    .where(eq(upgradeRunsTable.id, id))
    .returning();
  void logAudit(req, "upgrade.cancel", { resourceType: "upgrade_run", resourceId: id, resourceName: run.name });
  res.json(updated);
});

// DELETE /upgrades/:id — admin: only finished runs.
router.delete("/upgrades/:id", async (req, res) => {
  await requireAdminAuth(req);
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  const [run] = await db.select().from(upgradeRunsTable).where(eq(upgradeRunsTable.id, id)).limit(1);
  if (!run) {
    res.status(404).json({ error: "Upgrade run not found" });
    return;
  }
  if (run.status === "running") {
    res.status(400).json({ error: "Cancel the run before deleting it" });
    return;
  }
  await db.delete(upgradeRunsTable).where(eq(upgradeRunsTable.id, id));
  void logAudit(req, "upgrade.delete", { resourceType: "upgrade_run", resourceId: id, resourceName: run.name });
  res.json({ message: "Upgrade run deleted" });
});

export default router;
