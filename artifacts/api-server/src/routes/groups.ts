import { Router, type IRouter } from "express";
import { db, routerGroupsTable, groupRoutersTable, groupSubgroupsTable, routersTable } from "@workspace/db";
import { eq, inArray } from "drizzle-orm";
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

  const groupRouterLinks = await db
    .select()
    .from(groupRoutersTable)
    .where(eq(groupRoutersTable.groupId, id));

  const subgroupLinks = await db
    .select()
    .from(groupSubgroupsTable)
    .where(eq(groupSubgroupsTable.parentGroupId, id));

  let routers: any[] = [];
  if (groupRouterLinks.length > 0) {
    const routerIds = groupRouterLinks.map((r) => r.routerId);
    routers = await db
      .select()
      .from(routersTable)
      .where(inArray(routersTable.id, routerIds));
    routers = routers.map((r) => ({
      id: r.id,
      name: r.name,
      ipAddress: r.ipAddress,
      sshPort: r.sshPort,
      sshUsername: r.sshUsername,
      description: r.description,
      createdAt: r.createdAt,
    }));
  }

  let subGroups: any[] = [];
  if (subgroupLinks.length > 0) {
    const subGroupIds = subgroupLinks.map((s) => s.childGroupId);
    subGroups = await db
      .select()
      .from(routerGroupsTable)
      .where(inArray(routerGroupsTable.id, subGroupIds));
  }

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
      .where(eq(groupRoutersTable.groupId, groupId));
  } else {
    await db
      .delete(groupSubgroupsTable)
      .where(eq(groupSubgroupsTable.parentGroupId, groupId));
  }
  res.json({ message: "Member removed" });
});

export default router;
