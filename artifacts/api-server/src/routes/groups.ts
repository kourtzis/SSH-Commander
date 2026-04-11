// ─── Router Group Routes ────────────────────────────────────────────
// Hierarchical groups for organizing routers. Groups can contain
// individual routers and/or other groups (subgroups). When a job
// targets a group, resolveRouterIds() walks the tree to collect all routers.

import { Router, type IRouter } from "express";
import { db, routerGroupsTable, groupRoutersTable, groupSubgroupsTable, routersTable } from "@workspace/db";
import { eq, and, inArray, sql } from "drizzle-orm";
import {
  CreateGroupBody,
  UpdateGroupBody,
  AddGroupMemberBody,
  RemoveGroupMemberBody,
} from "@workspace/api-zod";
import { requireAuth } from "../lib/auth.js";

const router: IRouter = Router();

router.get("/groups", async (req, res) => {
  requireAuth(req);
  const groups = await db.select().from(routerGroupsTable).orderBy(routerGroupsTable.name);
  res.json(groups);
});

router.get("/groups-counts", async (req, res) => {
  requireAuth(req);
  const [subgroupCounts, deviceCounts] = await Promise.all([
    db.select({
      parentGroupId: groupSubgroupsTable.parentGroupId,
      count: sql<number>`count(*)::int`.as("count"),
    }).from(groupSubgroupsTable).groupBy(groupSubgroupsTable.parentGroupId),
    db.select({
      groupId: groupRoutersTable.groupId,
      count: sql<number>`count(*)::int`.as("count"),
    }).from(groupRoutersTable).groupBy(groupRoutersTable.groupId),
  ]);
  const counts: Record<number, { subgroups: number; devices: number }> = {};
  for (const row of subgroupCounts) {
    if (!counts[row.parentGroupId]) counts[row.parentGroupId] = { subgroups: 0, devices: 0 };
    counts[row.parentGroupId].subgroups = row.count;
  }
  for (const row of deviceCounts) {
    if (!counts[row.groupId]) counts[row.groupId] = { subgroups: 0, devices: 0 };
    counts[row.groupId].devices = row.count;
  }
  res.json(counts);
});

// POST /groups — Create a new group
router.post("/groups", async (req, res) => {
  requireAuth(req);
  const parsed = CreateGroupBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request body" });
    return;
  }
  const [newGroup] = await db
    .insert(routerGroupsTable)
    .values(parsed.data)
    .returning();
  res.status(201).json(newGroup);
});

// GET /groups/:id — Get group details with its router members and subgroups.
// Uses two parallel query rounds to minimize latency:
//   Round 1: fetch link IDs (groupRouters + groupSubgroups) in parallel
//   Round 2: fetch full router/subgroup details in parallel
router.get("/groups/:id", async (req, res) => {
  requireAuth(req);
  const id = parseInt(req.params.id);
  const [group] = await db
    .select()
    .from(routerGroupsTable)
    .where(eq(routerGroupsTable.id, id))
    .limit(1);
  if (!group) {
    res.status(404).json({ error: "Group not found" });
    return;
  }

  // Round 1: get the join table entries AND parentId-based children for this group
  const [groupRouterLinks, subgroupLinks, parentIdChildren] = await Promise.all([
    db
      .select({ routerId: groupRoutersTable.routerId })
      .from(groupRoutersTable)
      .where(eq(groupRoutersTable.groupId, id)),
    db
      .select({ childGroupId: groupSubgroupsTable.childGroupId })
      .from(groupSubgroupsTable)
      .where(eq(groupSubgroupsTable.parentGroupId, id)),
    db
      .select({ id: routerGroupsTable.id })
      .from(routerGroupsTable)
      .where(eq(routerGroupsTable.parentId, id)),
  ]);

  const childIds = new Set([
    ...subgroupLinks.map(s => s.childGroupId),
    ...parentIdChildren.map(c => c.id),
  ]);

  // Round 2: fetch the actual router and subgroup records (skipped if empty)
  const [routers, subGroups] = await Promise.all([
    groupRouterLinks.length > 0
      ? db
          .select({
            id: routersTable.id,
            name: routersTable.name,
            ipAddress: routersTable.ipAddress,
            sshPort: routersTable.sshPort,
            sshUsername: routersTable.sshUsername,
            description: routersTable.description,
            createdAt: routersTable.createdAt,
          })
          .from(routersTable)
          .where(inArray(routersTable.id, groupRouterLinks.map((r) => r.routerId)))
      : Promise.resolve([]),
    childIds.size > 0
      ? db
          .select()
          .from(routerGroupsTable)
          .where(inArray(routerGroupsTable.id, [...childIds]))
      : Promise.resolve([]),
  ]);

  res.json({ ...group, routers, subGroups });
});

// PUT /groups/:id — Update group name/description/parentId (partial update)
router.put("/groups/:id", async (req, res) => {
  requireAuth(req);
  const id = parseInt(req.params.id);
  const parsed = UpdateGroupBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request body" });
    return;
  }
  const updates: Record<string, any> = {};
  if (parsed.data.name !== undefined) updates.name = parsed.data.name;
  if (parsed.data.description !== undefined) updates.description = parsed.data.description;
  if (parsed.data.parentId !== undefined) updates.parentId = parsed.data.parentId;

  const [updated] = await db
    .update(routerGroupsTable)
    .set(updates)
    .where(eq(routerGroupsTable.id, id))
    .returning();
  if (!updated) {
    res.status(404).json({ error: "Group not found" });
    return;
  }
  res.json(updated);
});

// PUT /groups/:id/move — Move a group to a new parent (or to root).
// Updates both the parentId column and the group_subgroups join table.
// Prevents circular references by walking descendants before moving.
router.put("/groups/:id/move", async (req, res) => {
  requireAuth(req);
  const id = parseInt(req.params.id);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid group ID" }); return; }

  const { newParentId } = req.body as { newParentId: number | null };
  if (newParentId !== null && typeof newParentId !== "number") {
    res.status(400).json({ error: "newParentId must be a number or null" });
    return;
  }

  if (newParentId === id) {
    res.status(400).json({ error: "Cannot move a group under itself" });
    return;
  }

  const [group] = await db.select().from(routerGroupsTable).where(eq(routerGroupsTable.id, id)).limit(1);
  if (!group) { res.status(404).json({ error: "Group not found" }); return; }

  if (newParentId !== null) {
    const [targetParent] = await db.select().from(routerGroupsTable).where(eq(routerGroupsTable.id, newParentId)).limit(1);
    if (!targetParent) { res.status(404).json({ error: "Target parent group not found" }); return; }

    // Walk descendants of the group being moved to prevent circular references
    const descendants = new Set<number>();
    let frontier = [id];
    while (frontier.length > 0) {
      const children = await db
        .select({ childGroupId: groupSubgroupsTable.childGroupId })
        .from(groupSubgroupsTable)
        .where(inArray(groupSubgroupsTable.parentGroupId, frontier));
      frontier = [];
      for (const c of children) {
        if (!descendants.has(c.childGroupId)) {
          descendants.add(c.childGroupId);
          frontier.push(c.childGroupId);
        }
      }
    }
    if (descendants.has(newParentId)) {
      res.status(400).json({ error: "Cannot move a group under one of its own descendants" });
      return;
    }
  }

  // Wrap all mutations in a transaction for atomicity
  const [updated] = await db.transaction(async (tx) => {
    // Remove old parent link from group_subgroups
    await tx.delete(groupSubgroupsTable).where(eq(groupSubgroupsTable.childGroupId, id));

    // Add new parent link (if not moving to root)
    if (newParentId !== null) {
      await tx.insert(groupSubgroupsTable).values({ parentGroupId: newParentId, childGroupId: id }).onConflictDoNothing();
    }

    // Update parentId column
    return tx
      .update(routerGroupsTable)
      .set({ parentId: newParentId })
      .where(eq(routerGroupsTable.id, id))
      .returning();
  });

  res.json(updated);
});

// DELETE /groups/:id — Delete a group and clean up all its membership links.
// Removes: router members, parent subgroup links, child subgroup links, then the group itself.
router.delete("/groups/:id", async (req, res) => {
  requireAuth(req);
  const id = parseInt(req.params.id);
  await db.delete(groupRoutersTable).where(eq(groupRoutersTable.groupId, id));
  await db.delete(groupSubgroupsTable).where(eq(groupSubgroupsTable.parentGroupId, id));
  await db.delete(groupSubgroupsTable).where(eq(groupSubgroupsTable.childGroupId, id));
  await db.delete(routerGroupsTable).where(eq(routerGroupsTable.id, id));
  res.json({ message: "Group deleted" });
});

// POST /groups/:id/members — Add a router or subgroup to this group.
// Uses onConflictDoNothing to safely handle duplicate additions.
router.post("/groups/:id/members", async (req, res) => {
  requireAuth(req);
  const groupId = parseInt(req.params.id);
  const parsed = AddGroupMemberBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request body" });
    return;
  }
  const { type, memberId } = parsed.data;
  if (type === "router") {
    await db
      .insert(groupRoutersTable)
      .values({ groupId, routerId: memberId })
      .onConflictDoNothing();
  } else {
    if (memberId === groupId) {
      res.status(400).json({ error: "Cannot add group to itself" });
      return;
    }
    const descendants = new Set<number>();
    let frontier = [memberId];
    while (frontier.length > 0) {
      const children = await db
        .select({ childGroupId: groupSubgroupsTable.childGroupId })
        .from(groupSubgroupsTable)
        .where(inArray(groupSubgroupsTable.parentGroupId, frontier));
      frontier = [];
      for (const c of children) {
        if (!descendants.has(c.childGroupId)) {
          descendants.add(c.childGroupId);
          frontier.push(c.childGroupId);
        }
      }
    }
    if (descendants.has(groupId)) {
      res.status(400).json({ error: "Cannot add an ancestor group as a sub-group — this would create a circular reference" });
      return;
    }
    await db.transaction(async (tx) => {
      await tx
        .insert(groupSubgroupsTable)
        .values({ parentGroupId: groupId, childGroupId: memberId })
        .onConflictDoNothing();
      await tx
        .update(routerGroupsTable)
        .set({ parentId: groupId })
        .where(eq(routerGroupsTable.id, memberId));
    });
  }
  res.json({ message: "Member added" });
});

// DELETE /groups/:id/members — Remove a specific router or subgroup from this group.
// Filters by BOTH groupId AND memberId to avoid deleting unrelated links.
router.delete("/groups/:id/members", async (req, res) => {
  requireAuth(req);
  const groupId = parseInt(req.params.id);
  const parsed = RemoveGroupMemberBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request body" });
    return;
  }
  const { type, memberId } = parsed.data;
  if (type === "router") {
    await db
      .delete(groupRoutersTable)
      .where(and(eq(groupRoutersTable.groupId, groupId), eq(groupRoutersTable.routerId, memberId)));
  } else {
    const membership = await db.select({ parentGroupId: groupSubgroupsTable.parentGroupId }).from(groupSubgroupsTable).where(and(eq(groupSubgroupsTable.parentGroupId, groupId), eq(groupSubgroupsTable.childGroupId, memberId))).limit(1);
    if (!membership.length) {
      res.status(404).json({ error: "Sub-group is not a child of this group" });
      return;
    }

    const parentGroup = await db.select({ parentId: routerGroupsTable.parentId }).from(routerGroupsTable).where(eq(routerGroupsTable.id, groupId)).limit(1);
    const grandparentId = parentGroup[0]?.parentId ?? null;

    await db.transaction(async (tx) => {
      await tx
        .delete(groupSubgroupsTable)
        .where(and(eq(groupSubgroupsTable.parentGroupId, groupId), eq(groupSubgroupsTable.childGroupId, memberId)));
      await tx
        .update(routerGroupsTable)
        .set({ parentId: grandparentId })
        .where(eq(routerGroupsTable.id, memberId));

      if (grandparentId !== null) {
        const exists = await tx.select({ parentGroupId: groupSubgroupsTable.parentGroupId }).from(groupSubgroupsTable).where(and(eq(groupSubgroupsTable.parentGroupId, grandparentId), eq(groupSubgroupsTable.childGroupId, memberId))).limit(1);
        if (exists.length === 0) {
          await tx.insert(groupSubgroupsTable).values({ parentGroupId: grandparentId, childGroupId: memberId });
        }
      }
    });
  }
  res.json({ message: "Member removed" });
});

export default router;
