import { Router, type IRouter } from "express";
import {
  db,
  batchJobsTable,
  jobTasksTable,
  routersTable,
  routerGroupsTable,
  groupRoutersTable,
  groupSubgroupsTable,
} from "@workspace/db";
import { eq, and, inArray } from "drizzle-orm";
import { CreateJobBody } from "@workspace/api-zod";
import { getCurrentUser, requireAuth } from "../lib/auth.js";
import { executeSSHCommand, applyTagSubstitution } from "../lib/ssh.js";

const router: IRouter = Router();

async function resolveRouterIds(
  directRouterIds: number[],
  groupIds: number[],
  visited = new Set<number>()
): Promise<number[]> {
  const allIds = new Set<number>(directRouterIds);

  for (const groupId of groupIds) {
    if (visited.has(groupId)) continue;
    visited.add(groupId);

    const routerLinks = await db
      .select()
      .from(groupRoutersTable)
      .where(eq(groupRoutersTable.groupId, groupId));
    for (const link of routerLinks) {
      allIds.add(link.routerId);
    }

    const subgroupLinks = await db
      .select()
      .from(groupSubgroupsTable)
      .where(eq(groupSubgroupsTable.parentGroupId, groupId));
    if (subgroupLinks.length > 0) {
      const subGroupIds = subgroupLinks.map((s) => s.childGroupId);
      const subIds = await resolveRouterIds([], subGroupIds, visited);
      for (const id of subIds) allIds.add(id);
    }
  }

  return Array.from(allIds);
}

router.post("/jobs/resolve-count", async (req, res) => {
  requireAuth(req);
  const { targetRouterIds, targetGroupIds } = req.body ?? {};
  const allRouterIds = await resolveRouterIds(
    targetRouterIds ?? [],
    targetGroupIds ?? []
  );
  res.json({ count: allRouterIds.length });
});

router.get("/jobs", async (req, res) => {
  requireAuth(req);
  const jobs = await db
    .select()
    .from(batchJobsTable)
    .orderBy(batchJobsTable.createdAt);
  res.json(
    jobs.map((j) => ({
      ...j,
      completedAt: j.completedAt ?? null,
    }))
  );
});

router.post("/jobs", async (req, res) => {
  requireAuth(req);
  const user = await getCurrentUser(req);
  const parsed = CreateJobBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request body" });
    return;
  }

  const { name, scriptCode, targetRouterIds, targetGroupIds, excelData } = parsed.data;

  const allRouterIds = await resolveRouterIds(
    targetRouterIds ?? [],
    targetGroupIds ?? []
  );

  if (allRouterIds.length === 0) {
    res.status(400).json({ error: "No routers targeted" });
    return;
  }

  const routers = await db
    .select()
    .from(routersTable)
    .where(inArray(routersTable.id, allRouterIds));

  const [job] = await db
    .insert(batchJobsTable)
    .values({
      name,
      scriptCode,
      status: "pending",
      targetRouterIds: targetRouterIds ?? [],
      targetGroupIds: targetGroupIds ?? [],
      excelData: excelData as any,
      totalTasks: routers.length,
      completedTasks: 0,
      failedTasks: 0,
      createdBy: user!.id,
    })
    .returning();

  const tasks = routers.map((r) => ({
    jobId: job.id,
    routerId: r.id,
    routerName: r.name,
    routerIp: r.ipAddress,
    status: "pending" as const,
  }));

  await db.insert(jobTasksTable).values(tasks);

  await db
    .update(batchJobsTable)
    .set({ status: "running" })
    .where(eq(batchJobsTable.id, job.id));

  runJobInBackground(job.id, routers, scriptCode, excelData as Record<string, string>[] | undefined);

  res.status(201).json({
    ...job,
    status: "running",
    completedAt: null,
  });
});

function buildExcelLookup(
  excelData: Record<string, string>[] | undefined
): Map<string, Record<string, string>> | null {
  if (!excelData || excelData.length === 0) return null;

  const lookup = new Map<string, Record<string, string>>();
  for (const row of excelData) {
    const ip = row["ROUTER_IP"]?.trim();
    const name = row["ROUTER_NAME"]?.trim();
    if (ip) lookup.set(`ip:${ip}`, row);
    if (name) lookup.set(`name:${name.toLowerCase()}`, row);
  }
  return lookup;
}

function findExcelRow(
  router: { name: string; ipAddress: string },
  lookup: Map<string, Record<string, string>> | null,
  index: number,
  excelData?: Record<string, string>[]
): Record<string, string> {
  if (lookup) {
    const byIp = lookup.get(`ip:${router.ipAddress}`);
    if (byIp) return byIp;
    const byName = lookup.get(`name:${router.name.toLowerCase()}`);
    if (byName) return byName;
  }
  if (excelData && excelData.length > 0) {
    return excelData[index] ?? excelData[excelData.length - 1];
  }
  return {};
}

async function runJobInBackground(
  jobId: number,
  routers: (typeof routersTable.$inferSelect)[],
  scriptCode: string,
  excelData?: Record<string, string>[]
) {
  let completedCount = 0;
  let failedCount = 0;

  const excelLookup = buildExcelLookup(excelData);

  for (let i = 0; i < routers.length; i++) {
    const r = routers[i];

    const [task] = await db
      .select()
      .from(jobTasksTable)
      .where(and(eq(jobTasksTable.jobId, jobId), eq(jobTasksTable.routerId, r.id)))
      .limit(1);

    if (!task) continue;

    const [currentJob] = await db
      .select()
      .from(batchJobsTable)
      .where(eq(batchJobsTable.id, jobId))
      .limit(1);

    if (currentJob?.status === "cancelled") break;

    await db
      .update(jobTasksTable)
      .set({ status: "running", startedAt: new Date() })
      .where(eq(jobTasksTable.id, task.id));

    const row = findExcelRow(r, excelLookup, i, excelData);

    const finalScript = applyTagSubstitution(scriptCode, row);

    await db
      .update(jobTasksTable)
      .set({ resolvedScript: finalScript })
      .where(eq(jobTasksTable.id, task.id));

    if (!r.sshPassword) {
      const noPassLog = [
        `[${new Date().toISOString()}] SSH session initiated`,
        `[${new Date().toISOString()}] Target: ${r.sshUsername}@${r.ipAddress}:${r.sshPort}`,
        `[${new Date().toISOString()}] ERROR: No SSH password configured for this router`,
        `[${new Date().toISOString()}] Session aborted`,
      ].join("\n");
      await db
        .update(jobTasksTable)
        .set({
          status: "failed",
          errorMessage: "No SSH password configured for this router",
          connectionLog: noPassLog,
          completedAt: new Date(),
        })
        .where(eq(jobTasksTable.id, task.id));
      failedCount++;
    } else {
      const result = await executeSSHCommand(
        r.ipAddress,
        r.sshPort,
        r.sshUsername,
        r.sshPassword,
        finalScript
      );

      await db
        .update(jobTasksTable)
        .set({
          status: result.success ? "success" : "failed",
          output: result.output || null,
          errorMessage: result.errorMessage || null,
          connectionLog: result.connectionLog,
          completedAt: new Date(),
        })
        .where(eq(jobTasksTable.id, task.id));

      if (result.success) {
        completedCount++;
      } else {
        failedCount++;
      }
    }

    await db
      .update(batchJobsTable)
      .set({
        completedTasks: completedCount,
        failedTasks: failedCount,
      })
      .where(eq(batchJobsTable.id, jobId));
  }

  const finalStatus =
    failedCount === routers.length
      ? "failed"
      : completedCount + failedCount === routers.length
      ? "completed"
      : "failed";

  await db
    .update(batchJobsTable)
    .set({
      status: finalStatus as any,
      completedTasks: completedCount,
      failedTasks: failedCount,
      completedAt: new Date(),
    })
    .where(eq(batchJobsTable.id, jobId));
}

router.get("/jobs/:id", async (req, res) => {
  requireAuth(req);
  const id = parseInt(req.params.id);
  const [job] = await db
    .select()
    .from(batchJobsTable)
    .where(eq(batchJobsTable.id, id))
    .limit(1);
  if (!job) {
    res.status(404).json({ error: "Job not found" });
    return;
  }
  const tasks = await db
    .select()
    .from(jobTasksTable)
    .where(eq(jobTasksTable.jobId, id))
    .orderBy(jobTasksTable.id);

  res.json({
    ...job,
    completedAt: job.completedAt ?? null,
    tasks: tasks.map((t) => ({
      ...t,
      output: t.output ?? null,
      errorMessage: t.errorMessage ?? null,
      connectionLog: t.connectionLog ?? null,
      resolvedScript: t.resolvedScript ?? null,
      startedAt: t.startedAt ?? null,
      completedAt: t.completedAt ?? null,
    })),
  });
});

router.post("/jobs/:id/cancel", async (req, res) => {
  requireAuth(req);
  const id = parseInt(req.params.id);
  await db
    .update(batchJobsTable)
    .set({ status: "cancelled", completedAt: new Date() })
    .where(eq(batchJobsTable.id, id));
  res.json({ message: "Job cancelled" });
});

export default router;
