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
import { interactiveSessions, type LiveEvent } from "../lib/interactive-session.js";

const router: IRouter = Router();

async function resolveRouterIds(
  directRouterIds: number[],
  groupIds: number[],
  visited = new Set<number>()
): Promise<number[]> {
  const seen = new Set<number>();
  const ordered: number[] = [];

  function addUnique(id: number) {
    if (!seen.has(id)) {
      seen.add(id);
      ordered.push(id);
    }
  }

  for (const id of directRouterIds) {
    addUnique(id);
  }

  for (const groupId of groupIds) {
    if (visited.has(groupId)) continue;
    visited.add(groupId);

    const routerLinks = await db
      .select()
      .from(groupRoutersTable)
      .where(eq(groupRoutersTable.groupId, groupId));
    for (const link of routerLinks) {
      addUnique(link.routerId);
    }

    const subgroupLinks = await db
      .select()
      .from(groupSubgroupsTable)
      .where(eq(groupSubgroupsTable.parentGroupId, groupId));
    if (subgroupLinks.length > 0) {
      const subGroupIds = subgroupLinks.map((s) => s.childGroupId);
      const subIds = await resolveRouterIds([], subGroupIds, visited);
      for (const id of subIds) addUnique(id);
    }
  }

  return ordered;
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

  const { name, scriptCode, targetRouterIds, targetGroupIds, excelData, mode, autoConfirm } = parsed.data;

  const allRouterIds = await resolveRouterIds(
    targetRouterIds ?? [],
    targetGroupIds ?? []
  );

  if (allRouterIds.length === 0) {
    res.status(400).json({ error: "No routers targeted" });
    return;
  }

  if (mode === "schedule") {
    const [job] = await db
      .insert(batchJobsTable)
      .values({
        name,
        scriptCode,
        status: "scheduled",
        targetRouterIds: targetRouterIds ?? [],
        targetGroupIds: targetGroupIds ?? [],
        excelData: excelData as any,
        autoConfirm: autoConfirm ?? true,
        totalTasks: 0,
        completedTasks: 0,
        failedTasks: 0,
        createdBy: user!.id,
      })
      .returning();

    res.status(201).json({
      ...job,
      completedAt: null,
    });
    return;
  }

  const routersUnordered = await db
    .select()
    .from(routersTable)
    .where(inArray(routersTable.id, allRouterIds));

  const routerMap = new Map(routersUnordered.map(r => [r.id, r]));
  const routers = allRouterIds.map(id => routerMap.get(id)!).filter(Boolean);

  const [job] = await db
    .insert(batchJobsTable)
    .values({
      name,
      scriptCode,
      status: "pending",
      targetRouterIds: targetRouterIds ?? [],
      targetGroupIds: targetGroupIds ?? [],
      excelData: excelData as any,
      autoConfirm: autoConfirm ?? true,
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

  const insertedTasks = await db.insert(jobTasksTable).values(tasks).returning();

  await db
    .update(batchJobsTable)
    .set({ status: "running" })
    .where(eq(batchJobsTable.id, job.id));

  const useInteractive = !(autoConfirm ?? true);

  if (useInteractive) {
    interactiveSessions.startInteractiveJob(
      job.id,
      routers.map(r => ({ id: r.id, name: r.name, ipAddress: r.ipAddress, sshPort: r.sshPort, sshUsername: r.sshUsername, sshPassword: r.sshPassword })),
      scriptCode,
      excelData as Record<string, string>[] | undefined,
      false,
      insertedTasks.map(t => ({ id: t.id, routerId: t.routerId }))
    );
  } else {
    runJobInBackground(job.id, routers, scriptCode, excelData as Record<string, string>[] | undefined, autoConfirm ?? true)
      .catch((err) => {
        console.error(`[Job ${job.id}] Background execution failed:`, err);
        db.update(batchJobsTable)
          .set({ status: "failed", completedAt: new Date() })
          .where(eq(batchJobsTable.id, job.id))
          .catch(() => {});
      });
  }

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
  excelData?: Record<string, string>[],
  autoConfirm: boolean = true
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
        finalScript,
        30000,
        autoConfirm
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
      promptText: t.promptText ?? null,
      startedAt: t.startedAt ?? null,
      completedAt: t.completedAt ?? null,
    })),
  });
});

router.get("/jobs/:id/live", async (req, res) => {
  requireAuth(req);
  const id = parseInt(req.params.id);

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });

  res.write(":\n\n");

  const emitter = interactiveSessions.getJobEmitter(id);

  if (!emitter) {
    const [job] = await db
      .select()
      .from(batchJobsTable)
      .where(eq(batchJobsTable.id, id))
      .limit(1);
    if (job && (job.status === "completed" || job.status === "failed" || job.status === "cancelled")) {
      res.write(`data: ${JSON.stringify({ type: "job_complete", taskId: 0, jobStatus: job.status, completedTasks: job.completedTasks, failedTasks: job.failedTasks, totalTasks: job.totalTasks })}\n\n`);
    }
    res.end();
    return;
  }

  const waiting = interactiveSessions.getWaitingTasks(id);
  for (const w of waiting) {
    res.write(`data: ${JSON.stringify({ type: "input_required", taskId: w.taskId, routerId: w.routerId, routerName: w.routerName, routerIp: w.routerIp, promptText: w.promptText, promptType: w.promptType, status: "waiting_input" })}\n\n`);
  }

  const handler = (event: LiveEvent) => {
    try {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    } catch {}
  };

  emitter.on("event", handler);

  const heartbeat = setInterval(() => {
    try { res.write(":\n\n"); } catch {}
  }, 15000);

  req.on("close", () => {
    emitter.off("event", handler);
    clearInterval(heartbeat);
  });
});

router.post("/jobs/:id/respond", async (req, res) => {
  requireAuth(req);
  const id = parseInt(req.params.id);
  const { taskIds, input } = req.body ?? {};

  if (!Array.isArray(taskIds) || typeof input !== "string") {
    res.status(400).json({ error: "taskIds (array) and input (string) are required" });
    return;
  }

  const result = await interactiveSessions.sendInput(id, taskIds, input);
  res.json(result);
});

router.put("/jobs/:id", async (req, res) => {
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
  if (job.status !== "scheduled") {
    res.status(400).json({ error: "Only scheduled jobs can be edited" });
    return;
  }
  const parsed = CreateJobBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request body" });
    return;
  }
  const { name, scriptCode, targetRouterIds, targetGroupIds, excelData, autoConfirm } = parsed.data;
  const [updated] = await db
    .update(batchJobsTable)
    .set({
      name,
      scriptCode,
      targetRouterIds: targetRouterIds ?? [],
      targetGroupIds: targetGroupIds ?? [],
      excelData: excelData as any,
      autoConfirm: autoConfirm ?? job.autoConfirm,
    })
    .where(eq(batchJobsTable.id, id))
    .returning();
  res.json({ ...updated, completedAt: updated.completedAt ?? null });
});

router.delete("/jobs/:id", async (req, res) => {
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
  await db.delete(jobTasksTable).where(eq(jobTasksTable.jobId, id));
  await db.delete(batchJobsTable).where(eq(batchJobsTable.id, id));
  res.json({ message: "Job deleted" });
});

router.post("/jobs/:id/rerun", async (req, res) => {
  requireAuth(req);
  const user = await getCurrentUser(req);
  const id = parseInt(req.params.id);

  const [sourceJob] = await db
    .select()
    .from(batchJobsTable)
    .where(eq(batchJobsTable.id, id))
    .limit(1);

  if (!sourceJob) {
    res.status(404).json({ error: "Job not found" });
    return;
  }

  const allRouterIds = await resolveRouterIds(
    sourceJob.targetRouterIds ?? [],
    sourceJob.targetGroupIds ?? []
  );

  if (allRouterIds.length === 0) {
    res.status(400).json({ error: "No routers targeted" });
    return;
  }

  const routersUnordered = await db
    .select()
    .from(routersTable)
    .where(inArray(routersTable.id, allRouterIds));

  const routerMap = new Map(routersUnordered.map(r => [r.id, r]));
  const routers = allRouterIds.map(id => routerMap.get(id)!).filter(Boolean);

  const [newJob] = await db
    .insert(batchJobsTable)
    .values({
      name: sourceJob.name,
      scriptCode: sourceJob.scriptCode,
      status: "pending",
      targetRouterIds: sourceJob.targetRouterIds ?? [],
      targetGroupIds: sourceJob.targetGroupIds ?? [],
      excelData: sourceJob.excelData as any,
      autoConfirm: sourceJob.autoConfirm,
      totalTasks: routers.length,
      completedTasks: 0,
      failedTasks: 0,
      createdBy: user!.id,
    })
    .returning();

  const tasks = routers.map((r) => ({
    jobId: newJob.id,
    routerId: r.id,
    routerName: r.name,
    routerIp: r.ipAddress,
    status: "pending" as const,
  }));

  const insertedTasks = await db.insert(jobTasksTable).values(tasks).returning();

  await db
    .update(batchJobsTable)
    .set({ status: "running" })
    .where(eq(batchJobsTable.id, newJob.id));

  const useInteractive = !sourceJob.autoConfirm;

  if (useInteractive) {
    interactiveSessions.startInteractiveJob(
      newJob.id,
      routers.map(r => ({ id: r.id, name: r.name, ipAddress: r.ipAddress, sshPort: r.sshPort, sshUsername: r.sshUsername, sshPassword: r.sshPassword })),
      sourceJob.scriptCode,
      sourceJob.excelData as Record<string, string>[] | undefined,
      false,
      insertedTasks.map(t => ({ id: t.id, routerId: t.routerId }))
    );
  } else {
    runJobInBackground(newJob.id, routers, sourceJob.scriptCode, sourceJob.excelData as Record<string, string>[] | undefined, sourceJob.autoConfirm)
      .catch((err) => {
        console.error(`[Job ${newJob.id}] Background execution failed:`, err);
        db.update(batchJobsTable)
          .set({ status: "failed", completedAt: new Date() })
          .where(eq(batchJobsTable.id, newJob.id))
          .catch(() => {});
      });
  }

  res.status(201).json({
    ...newJob,
    status: "running",
    completedAt: null,
  });
});

router.post("/jobs/:id/cancel", async (req, res) => {
  requireAuth(req);
  const id = parseInt(req.params.id);

  await interactiveSessions.cleanupJob(id);

  await db
    .update(batchJobsTable)
    .set({ status: "cancelled", completedAt: new Date() })
    .where(eq(batchJobsTable.id, id));
  res.json({ message: "Job cancelled" });
});

export default router;
