import { Router, type IRouter } from "express";
import { db, routerGroupsTable, groupRoutersTable, groupSubgroupsTable, routersTable } from "@workspace/db";
import { eq, and, inArray } from "drizzle-orm";
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

  const [groupRouterLinks, subgroupLinks] = await Promise.all([
    db
      .select({ routerId: groupRoutersTable.routerId })
      .from(groupRoutersTable)
      .where(eq(groupRoutersTable.groupId, id)),
    db
      .select({ childGroupId: groupSubgroupsTable.childGroupId })
      .from(groupSubgroupsTable)
      .where(eq(groupSubgroupsTable.parentGroupId, id)),
  ]);

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
    subgroupLinks.length > 0
      ? db
          .select()
          .from(routerGroupsTable)
          .where(inArray(routerGroupsTable.id, subgroupLinks.map((s) => s.childGroupId)))
      : Promise.resolve([]),
  ]);

  res.json({ ...group, routers, subGroups });
});

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

router.delete("/groups/:id", async (req, res) => {
  requireAuth(req);
  const id = parseInt(req.params.id);
  await db.delete(groupRoutersTable).where(eq(groupRoutersTable.groupId, id));
  await db.delete(groupSubgroupsTable).where(eq(groupSubgroupsTable.parentGroupId, id));
  await db.delete(groupSubgroupsTable).where(eq(groupSubgroupsTable.childGroupId, id));
  await db.delete(routerGroupsTable).where(eq(routerGroupsTable.id, id));
  res.json({ message: "Group deleted" });
});

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
    await db
      .insert(groupSubgroupsTable)
      .values({ parentGroupId: groupId, childGroupId: memberId })
      .onConflictDoNothing();
  }
  res.json({ message: "Member added" });
});

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
    await db
      .delete(groupSubgroupsTable)
      .where(and(eq(groupSubgroupsTable.parentGroupId, groupId), eq(groupSubgroupsTable.childGroupId, memberId)));
  }
  res.json({ message: "Member removed" });
});

export default router;
