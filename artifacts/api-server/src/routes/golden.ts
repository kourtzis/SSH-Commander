// ─── Golden config + drift routes ───────────────────────────────────
// A golden config is the intended baseline for every router in a group.
// Checks compare each member's LATEST successful backup against the
// baseline (both sides normalized + ignore patterns applied) — no SSH
// happens here; operators run backups first if they want fresh data.

import { Router, type IRouter } from "express";
import {
  db,
  goldenConfigsTable,
  driftResultsTable,
  configBackupsTable,
  routerGroupsTable,
  routersTable,
} from "@workspace/db";
import { and, desc, eq, inArray, max } from "drizzle-orm";
import { CreateGoldenConfigBody, UpdateGoldenConfigBody } from "@workspace/api-zod";
import { requireAuth, requireAdminAuth } from "../lib/auth.js";
import { resolveRouterIds } from "../lib/resolve-routers.js";
import { runDriftCheckForGolden } from "../lib/drift-check.js";
import { logAudit } from "../lib/audit.js";

const router: IRouter = Router();

async function goldenWithStats(golden: typeof goldenConfigsTable.$inferSelect, groupName: string) {
  const memberIds = await resolveRouterIds([], [golden.groupId]);
  const results = await db
    .select({ inSync: driftResultsTable.inSync, checkedAt: driftResultsTable.checkedAt })
    .from(driftResultsTable)
    .where(eq(driftResultsTable.goldenConfigId, golden.id));
  const drifted = results.filter((r) => !r.inSync).length;
  const lastCheckedAt = results.reduce<Date | null>(
    (acc, r) => (acc === null || r.checkedAt > acc ? r.checkedAt : acc),
    null,
  );
  return {
    ...golden,
    groupName,
    routerCount: memberIds.length,
    driftedCount: drifted,
    lastCheckedAt,
  };
}

// GET /golden-configs — list with drift summaries.
router.get("/golden-configs", async (req, res) => {
  requireAuth(req);
  const rows = await db
    .select({ golden: goldenConfigsTable, groupName: routerGroupsTable.name })
    .from(goldenConfigsTable)
    .innerJoin(routerGroupsTable, eq(goldenConfigsTable.groupId, routerGroupsTable.id))
    .orderBy(goldenConfigsTable.name);
  const out = await Promise.all(rows.map((r) => goldenWithStats(r.golden, r.groupName)));
  res.json(out);
});

// POST /golden-configs — admin.
router.post("/golden-configs", async (req, res) => {
  const user = await requireAdminAuth(req);
  const parsed = CreateGoldenConfigBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request body" });
    return;
  }
  const { groupId, name, content, ignorePatterns } = parsed.data;
  const [group] = await db.select().from(routerGroupsTable).where(eq(routerGroupsTable.id, groupId)).limit(1);
  if (!group) {
    res.status(404).json({ error: "Group not found" });
    return;
  }
  const [created] = await db.insert(goldenConfigsTable).values({
    groupId,
    name,
    content,
    ignorePatterns: ignorePatterns ?? [],
    updatedBy: user.id,
  }).returning();
  void logAudit(req, "golden.create", { resourceType: "golden_config", resourceId: created.id, resourceName: name });
  res.status(201).json(await goldenWithStats(created, group.name));
});

// PUT /golden-configs/:id — admin.
router.put("/golden-configs/:id", async (req, res) => {
  const user = await requireAdminAuth(req);
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  const parsed = UpdateGoldenConfigBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request body" });
    return;
  }
  const patch: Record<string, unknown> = { updatedAt: new Date(), updatedBy: user.id };
  if (parsed.data.name !== undefined) patch.name = parsed.data.name;
  if (parsed.data.content !== undefined) patch.content = parsed.data.content;
  if (parsed.data.ignorePatterns !== undefined) patch.ignorePatterns = parsed.data.ignorePatterns;
  const [updated] = await db.update(goldenConfigsTable).set(patch).where(eq(goldenConfigsTable.id, id)).returning();
  if (!updated) {
    res.status(404).json({ error: "Golden config not found" });
    return;
  }
  const [group] = await db.select().from(routerGroupsTable).where(eq(routerGroupsTable.id, updated.groupId)).limit(1);
  void logAudit(req, "golden.update", { resourceType: "golden_config", resourceId: id, resourceName: updated.name });
  res.json(await goldenWithStats(updated, group?.name ?? ""));
});

// DELETE /golden-configs/:id — admin (drift results cascade).
router.delete("/golden-configs/:id", async (req, res) => {
  await requireAdminAuth(req);
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  const [deleted] = await db.delete(goldenConfigsTable).where(eq(goldenConfigsTable.id, id))
    .returning({ id: goldenConfigsTable.id, name: goldenConfigsTable.name });
  if (!deleted) {
    res.status(404).json({ error: "Golden config not found" });
    return;
  }
  void logAudit(req, "golden.delete", { resourceType: "golden_config", resourceId: id, resourceName: deleted.name });
  res.json({ message: "Golden config deleted" });
});

// POST /golden-configs/:id/check — compare members' latest backups to the baseline.
router.post("/golden-configs/:id/check", async (req, res) => {
  requireAuth(req);
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  const [golden] = await db.select().from(goldenConfigsTable).where(eq(goldenConfigsTable.id, id)).limit(1);
  if (!golden) {
    res.status(404).json({ error: "Golden config not found" });
    return;
  }
  const summary = await runDriftCheckForGolden(golden);
  void logAudit(req, "golden.check", {
    resourceType: "golden_config",
    resourceId: id,
    resourceName: golden.name,
    details: { checked: summary.checked, drifted: summary.drifted, skipped: summary.skipped },
  });
  res.json(summary);
});

// GET /golden-configs/:id/results — latest verdicts (drifted first).
router.get("/golden-configs/:id/results", async (req, res) => {
  requireAuth(req);
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  const rows = await db.select().from(driftResultsTable)
    .where(eq(driftResultsTable.goldenConfigId, id))
    .orderBy(driftResultsTable.inSync, driftResultsTable.routerName);
  res.json(rows);
});

export default router;

// max import kept out of the hot path — referenced to avoid unused warnings
void max;
