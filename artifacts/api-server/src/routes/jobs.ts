// ─── Batch Job Routes ───────────────────────────────────────────────
// Create, monitor, rerun, and cancel batch SSH jobs. A job runs a script
// across multiple routers (resolved from direct IDs + group hierarchy).
// Supports two execution modes:
//   - Auto-confirm (default): runs in background, auto-answers y/n prompts
//   - Interactive: opens parallel SSH sessions with SSE live streaming,
//     pauses at prompts for user input via the /respond endpoint

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
import { eq, and, inArray, sql } from "drizzle-orm";
import { CreateJobBody } from "@workspace/api-zod";
import { getCurrentUser, requireAuth } from "../lib/auth.js";
import { executeSSHCommand, applyTagSubstitution } from "../lib/ssh.js";
import { interactiveSessions, type LiveEvent } from "../lib/interactive-session.js";

const router: IRouter = Router();

// ─── Group Resolution ───────────────────────────────────────────────
// Iterative BFS that walks the group hierarchy and collects all router IDs.
// Each depth level is processed in 2 parallel queries (router links + subgroup links).
// Returns de-duplicated IDs preserving insertion order (direct routers first).
async function resolveRouterIds(
  directRouterIds: number[],
  groupIds: number[]
): Promise<number[]> {
  const seen = new Set<number>();
  const ordered: number[] = [];

  function addUnique(id: number) {
    if (!seen.has(id)) {
      seen.add(id);
      ordered.push(id);
    }
  }

  // Add directly-selected routers first
  for (const id of directRouterIds) {
    addUnique(id);
  }

  // BFS through group tree — `pending` = groups at the current depth level
  const visited = new Set<number>();
  let pending = groupIds.filter((id) => !visited.has(id));

  while (pending.length > 0) {
    for (const id of pending) visited.add(id);

    // Fetch router members and child subgroups in parallel
    const [routerLinks, subgroupLinks] = await Promise.all([
      db
        .select({ routerId: groupRoutersTable.routerId })
        .from(groupRoutersTable)
        .where(inArray(groupRoutersTable.groupId, pending)),
      db
        .select({ childGroupId: groupSubgroupsTable.childGroupId })
        .from(groupSubgroupsTable)
        .where(inArray(groupSubgroupsTable.parentGroupId, pending)),
    ]);

    for (const link of routerLinks) {
      addUnique(link.routerId);
    }

    // Move to next depth level, skipping already-visited groups (prevents cycles)
    pending = subgroupLinks
      .map((s) => s.childGroupId)
      .filter((id) => !visited.has(id));
  }

  return ordered;
}

// POST /jobs/resolve-count — Preview how many routers a job would target
// (used by the UI to show "X routers will be affected" before creating the job)
router.post("/jobs/resolve-count", async (req, res) => {
  requireAuth(req);
  const { targetRouterIds, targetGroupIds } = req.body ?? {};
  const allRouterIds = await resolveRouterIds(
    targetRouterIds ?? [],
    targetGroupIds ?? []
  );
  res.json({ count: allRouterIds.length });
});

// GET /jobs — List all jobs (most recent last)
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

// POST /jobs — Create and execute a new batch job.
// If mode="schedule", creates a template job (status="scheduled") for the scheduler.
// Otherwise, resolves routers, creates tasks, and starts execution immediately.
router.post("/jobs", async (req, res) => {
  requireAuth(req);
  const user = await getCurrentUser(req);
  const parsed = CreateJobBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request body" });
    return;
  }

  const { name, scriptCode, targetRouterIds, targetGroupIds, excelData, mode, autoConfirm } = parsed.data;

  // Resolve all target routers from direct IDs + group membership
  const allRouterIds = await resolveRouterIds(
    targetRouterIds ?? [],
    targetGroupIds ?? []
  );

  if (allRouterIds.length === 0) {
    res.status(400).json({ error: "No routers targeted" });
    return;
  }

  // Schedule mode: save as a template without executing
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

  // Fetch full router details and preserve the resolved ordering
  const routersUnordered = await db
    .select()
    .from(routersTable)
    .where(inArray(routersTable.id, allRouterIds));

  const routerMap = new Map(routersUnordered.map(r => [r.id, r]));
  const routers = allRouterIds.map(id => routerMap.get(id)!).filter(Boolean);

  // Create the parent job record
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

  // Create one pending task per router
  const tasks = routers.map((r) => ({
    jobId: job.id,
    routerId: r.id,
    routerName: r.name,
    routerIp: r.ipAddress,
    status: "pending" as const,
  }));

  const insertedTasks = await db.insert(jobTasksTable).values(tasks).returning();

  // Transition job to "running"
  await db
    .update(batchJobsTable)
    .set({ status: "running" })
    .where(eq(batchJobsTable.id, job.id));

  // Choose execution mode based on autoConfirm setting
  const useInteractive = !(autoConfirm ?? true);

  if (useInteractive) {
    // Interactive mode: parallel SSH sessions with live SSE streaming
    interactiveSessions.startInteractiveJob(
      job.id,
      routers.map(r => ({ id: r.id, name: r.name, ipAddress: r.ipAddress, sshPort: r.sshPort, sshUsername: r.sshUsername, sshPassword: r.sshPassword })),
      scriptCode,
      excelData as Record<string, string>[] | undefined,
      false,
      insertedTasks.map(t => ({ id: t.id, routerId: t.routerId }))
    );
  } else {
    // Auto-confirm mode: sequential background execution
    runJobInBackground(job.id, routers, scriptCode, excelData as Record<string, string>[] | undefined, autoConfirm ?? true, insertedTasks.map(t => t.id))
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

// ─── Excel Variable Substitution Helpers ────────────────────────────

// Build a fast lookup map from Excel data keyed by "ip:<address>" and "name:<lowercase>"
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

// Match a router to its Excel row: tries IP → name → positional index → last row
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

// ─── Background Job Runner ──────────────────────────────────────────
// Executes SSH commands sequentially across all routers in a job.
// Updates task status and job counters after each router completes.
async function runJobInBackground(
  jobId: number,
  routers: (typeof routersTable.$inferSelect)[],
  scriptCode: string,
  excelData?: Record<string, string>[],
  autoConfirm: boolean = true,
  taskIds?: number[]
) {
  let completedCount = 0;
  let failedCount = 0;

  const excelLookup = buildExcelLookup(excelData);

  // Build a task ID lookup from the pre-inserted task IDs (avoids re-querying DB)
  const taskIdByRouterId = new Map<number, number>();
  if (taskIds) {
    for (let i = 0; i < routers.length && i < taskIds.length; i++) {
      taskIdByRouterId.set(routers[i].id, taskIds[i]);
    }
  }

  for (let i = 0; i < routers.length; i++) {
    const r = routers[i];

    // Use pre-mapped task ID; fallback to DB lookup only if missing
    let taskId = taskIdByRouterId.get(r.id);
    if (!taskId) {
      const [task] = await db
        .select({ id: jobTasksTable.id })
        .from(jobTasksTable)
        .where(and(eq(jobTasksTable.jobId, jobId), eq(jobTasksTable.routerId, r.id)))
        .limit(1);
      if (!task) continue;
      taskId = task.id;
    }

    // Check for cancellation every 5 routers (reduces DB queries by 80%)
    if (i % 5 === 0) {
      const [currentJob] = await db
        .select({ status: batchJobsTable.status })
        .from(batchJobsTable)
        .where(eq(batchJobsTable.id, jobId))
        .limit(1);
      if (currentJob?.status === "cancelled") break;
    }

    // Substitute {{TAG}} placeholders with matching Excel row values
    const row = findExcelRow(r, excelLookup, i, excelData);
    const finalScript = applyTagSubstitution(scriptCode, row);

    // Mark task as running and store the resolved script (combined into one UPDATE)
    await db
      .update(jobTasksTable)
      .set({ status: "running", startedAt: new Date(), resolvedScript: finalScript })
      .where(eq(jobTasksTable.id, taskId));

    if (!r.sshPassword) {
      // No password configured — fail immediately with a clear log
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
        .where(eq(jobTasksTable.id, taskId));
      failedCount++;
    } else {
      // Execute the SSH command against this router
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
        .where(eq(jobTasksTable.id, taskId));

      if (result.success) {
        completedCount++;
      } else {
        failedCount++;
      }
    }

    // Update running counters on the parent job
    await db
      .update(batchJobsTable)
      .set({
        completedTasks: completedCount,
        failedTasks: failedCount,
      })
      .where(eq(batchJobsTable.id, jobId));
  }

  // Determine final status: "failed" only if every task failed
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

// GET /jobs/:id — Get full job details including all tasks
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

// ─── SSE Live Stream ────────────────────────────────────────────────
// GET /jobs/:id/live — Server-Sent Events endpoint for real-time job updates.
// Subscribes to the interactive session's event emitter and streams
// task_status, task_output, input_required, and job_complete events.
router.get("/jobs/:id/live", async (req, res) => {
  requireAuth(req);
  const id = parseInt(req.params.id);

  // Set up SSE headers
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",  // Disable nginx buffering for real-time streaming
  });

  res.write(":\n\n");  // SSE comment — keeps the connection alive

  const emitter = interactiveSessions.getJobEmitter(id);

  if (!emitter) {
    // No active session — check if the job already finished and send final status
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

  // Send current waiting-for-input prompts (in case the user reconnects mid-job)
  const waiting = interactiveSessions.getWaitingTasks(id);
  for (const w of waiting) {
    res.write(`data: ${JSON.stringify({ type: "input_required", taskId: w.taskId, routerId: w.routerId, routerName: w.routerName, routerIp: w.routerIp, promptText: w.promptText, promptType: w.promptType, status: "waiting_input" })}\n\n`);
  }

  // Subscribe to live events from the interactive session
  const handler = (event: LiveEvent) => {
    try {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    } catch {}
  };

  emitter.on("event", handler);

  // Keepalive: send a comment every 15s to prevent proxy/browser timeouts
  const heartbeat = setInterval(() => {
    try { res.write(":\n\n"); } catch {}
  }, 15000);

  // Cleanup on client disconnect
  req.on("close", () => {
    emitter.off("event", handler);
    clearInterval(heartbeat);
  });
});

// POST /jobs/:id/respond — Forward user input to waiting interactive SSH sessions.
// Used when a prompt is detected and the UI collects the user's response.
router.post("/jobs/:id/respond", async (req, res) => {
  requireAuth(req);
  const id = parseInt(req.params.id);
  if (isNaN(id)) {
    res.status(400).json({ error: "Invalid job ID" });
    return;
  }
  const { taskIds, input } = req.body ?? {};

  // Validate: taskIds must be an array of integers, input must be a string
  if (!Array.isArray(taskIds) || !taskIds.every((t: any) => Number.isInteger(t)) || typeof input !== "string") {
    res.status(400).json({ error: "taskIds (array of integers) and input (string) are required" });
    return;
  }

  // Limit input length to prevent abuse
  if (input.length > 4096) {
    res.status(400).json({ error: "Input too long (max 4096 characters)" });
    return;
  }

  const result = await interactiveSessions.sendInput(id, taskIds, input);
  res.json(result);
});

// PUT /jobs/:id — Edit a scheduled (template) job. Only jobs with status="scheduled" can be edited.
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

// DELETE /jobs/:id — Delete a job and all its tasks
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
  // Delete tasks first (child records), then the parent job
  await db.delete(jobTasksTable).where(eq(jobTasksTable.jobId, id));
  await db.delete(batchJobsTable).where(eq(batchJobsTable.id, id));
  res.json({ message: "Job deleted" });
});

// POST /jobs/:id/rerun — Clone a completed/failed job and re-execute it.
// Creates a new job with fresh tasks using the same script, targets, and Excel data.
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

  // Re-resolve routers (group membership may have changed since the original run)
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

  // Create the cloned job
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

  // Use the same execution mode as the original job
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
    runJobInBackground(newJob.id, routers, sourceJob.scriptCode, sourceJob.excelData as Record<string, string>[] | undefined, sourceJob.autoConfirm, insertedTasks.map(t => t.id))
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

// POST /jobs/:id/cancel — Cancel a running or interactive job.
// Cleans up any active SSH sessions and marks the job as cancelled.
router.post("/jobs/:id/cancel", async (req, res) => {
  requireAuth(req);
  const id = parseInt(req.params.id);

  // Clean up interactive sessions (closes SSH connections, fails pending tasks)
  await interactiveSessions.cleanupJob(id);

  await db
    .update(batchJobsTable)
    .set({ status: "cancelled", completedAt: new Date() })
    .where(eq(batchJobsTable.id, id));
  res.json({ message: "Job cancelled" });
});

export default router;
