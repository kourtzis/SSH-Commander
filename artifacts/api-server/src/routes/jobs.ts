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
  schedulesTable,
} from "@workspace/db";
import { eq, and, inArray, sql } from "drizzle-orm";
import { CreateJobBody } from "@workspace/api-zod";
import { getCurrentUser, requireAuth } from "../lib/auth.js";
import { executeSSH, applyTagSubstitution } from "../lib/ssh.js";
import { interactiveSessions, type LiveEvent } from "../lib/interactive-session.js";
import { resolveRouterIds, buildExcelLookup, findExcelRow, runConcurrent } from "../lib/resolve-routers.js";

const router: IRouter = Router();


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

  const { name, scriptCode, targetRouterIds, targetGroupIds, excelData, mode, autoConfirm, timeoutSeconds, retryCount, retryBackoffSeconds } = parsed.data;

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
        timeoutSeconds: timeoutSeconds ?? 30,
        retryCount: retryCount ?? 0,
        retryBackoffSeconds: retryBackoffSeconds ?? 5,
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
      timeoutSeconds: timeoutSeconds ?? 30,
      retryCount: retryCount ?? 0,
      retryBackoffSeconds: retryBackoffSeconds ?? 5,
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
    runJobInBackground(job.id, routers, scriptCode, excelData as Record<string, string>[] | undefined, autoConfirm ?? true, insertedTasks.map(t => t.id), { timeoutSeconds: timeoutSeconds ?? 30, retryCount: retryCount ?? 0, retryBackoffSeconds: retryBackoffSeconds ?? 5 })
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

// ─── Background Job Runner ──────────────────────────────────────────
// Executes SSH commands concurrently (up to 10 at a time) across all routers.
// Updates task status and job counters after each router completes.
async function runJobInBackground(
  jobId: number,
  routers: (typeof routersTable.$inferSelect)[],
  scriptCode: string,
  excelData?: Record<string, string>[],
  autoConfirm: boolean = true,
  taskIds?: number[],
  reliability: { timeoutSeconds: number; retryCount: number; retryBackoffSeconds: number } = { timeoutSeconds: 30, retryCount: 0, retryBackoffSeconds: 5 },
) {
  let completedCount = 0;
  let failedCount = 0;
  let cancelled = false;

  const excelLookup = buildExcelLookup(excelData);

  const taskIdByRouterId = new Map<number, number>();
  if (taskIds) {
    for (let i = 0; i < routers.length && i < taskIds.length; i++) {
      taskIdByRouterId.set(routers[i].id, taskIds[i]);
    }
  }

  await runConcurrent(routers, async (r, i) => {
    if (cancelled) return;

    let taskId = taskIdByRouterId.get(r.id);
    if (!taskId) {
      const [task] = await db
        .select({ id: jobTasksTable.id })
        .from(jobTasksTable)
        .where(and(eq(jobTasksTable.jobId, jobId), eq(jobTasksTable.routerId, r.id)))
        .limit(1);
      if (!task) return;
      taskId = task.id;
    }

    if (i % 20 === 0) {
      const [currentJob] = await db
        .select({ status: batchJobsTable.status })
        .from(batchJobsTable)
        .where(eq(batchJobsTable.id, jobId))
        .limit(1);
      if (currentJob?.status === "cancelled") {
        cancelled = true;
        return;
      }
    }

    const row = findExcelRow(r, excelLookup, i, excelData);
    const finalScript = applyTagSubstitution(scriptCode, row);

    await db
      .update(jobTasksTable)
      .set({ status: "running", startedAt: new Date(), resolvedScript: finalScript })
      .where(eq(jobTasksTable.id, taskId));

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
        .where(eq(jobTasksTable.id, taskId));
      failedCount++;
    } else {
      const result = await executeSSH(
        r.ipAddress,
        r.sshPort,
        r.sshUsername,
        r.sshPassword,
        finalScript,
        {
          timeoutMs: reliability.timeoutSeconds * 1000,
          autoConfirm,
          enablePassword: r.enablePassword ?? undefined,
          retryCount: reliability.retryCount,
          retryBackoffSeconds: reliability.retryBackoffSeconds,
        },
      );

      await db
        .update(jobTasksTable)
        .set({
          status: result.success ? "success" : "failed",
          output: result.output || null,
          errorMessage: result.errorMessage || null,
          connectionLog: result.connectionLog,
          attemptCount: result.attemptCount,
          completedAt: new Date(),
        })
        .where(eq(jobTasksTable.id, taskId));

      if (result.success) {
        completedCount++;
      } else {
        failedCount++;
      }
    }

    await db
      .update(batchJobsTable)
      .set({ completedTasks: completedCount, failedTasks: failedCount })
      .where(eq(batchJobsTable.id, jobId));
  }, 10);

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

// GET /jobs/:id — Get job details including all tasks.
//
// Performance: this endpoint is polled every 2 seconds while a job is running,
// so we deliberately strip the two heavyweight per-task fields (`output` and
// `connectionLog` — each can be megabytes) and the original `excelData`
// import blob from the response. The detail page lazy-fetches the full task
// payload via GET /jobs/:jobId/tasks/:taskId when the user expands a row.
//
// Internal consumers that DO need the full output (export endpoint, rerun)
// query `jobTasksTable` directly and aren't affected.
router.get("/jobs/:id", async (req, res) => {
  requireAuth(req);
  const id = parseInt(req.params.id);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid job id" }); return; }

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
    .select({
      id: jobTasksTable.id,
      jobId: jobTasksTable.jobId,
      routerId: jobTasksTable.routerId,
      routerName: jobTasksTable.routerName,
      routerIp: jobTasksTable.routerIp,
      status: jobTasksTable.status,
      errorMessage: jobTasksTable.errorMessage,
      resolvedScript: jobTasksTable.resolvedScript,
      promptText: jobTasksTable.promptText,
      attemptCount: jobTasksTable.attemptCount,
      startedAt: jobTasksTable.startedAt,
      completedAt: jobTasksTable.completedAt,
    })
    .from(jobTasksTable)
    .where(eq(jobTasksTable.jobId, id))
    .orderBy(jobTasksTable.id);

  // Strip excelData from job — the client never needs it after creation.
  const { excelData: _excelData, ...jobLite } = job as any;

  res.json({
    ...jobLite,
    completedAt: job.completedAt ?? null,
    tasks: tasks.map((t) => ({
      ...t,
      // Provide null placeholders for the stripped fields so the client
      // schema (Task) still matches the response shape; the detail page
      // fetches real values lazily via /jobs/:jobId/tasks/:taskId.
      output: null as string | null,
      connectionLog: null as string | null,
      errorMessage: t.errorMessage ?? null,
      resolvedScript: t.resolvedScript ?? null,
      promptText: t.promptText ?? null,
      startedAt: t.startedAt ?? null,
      completedAt: t.completedAt ?? null,
    })),
  });
});

// GET /jobs/:jobId/tasks/:taskId — Fetch a single task's full payload
// (output + connectionLog) on demand. Used by the detail page when the
// user expands a task row in lite mode.
router.get("/jobs/:jobId/tasks/:taskId", async (req, res) => {
  requireAuth(req);
  const jobId = parseInt(req.params.jobId);
  const taskId = parseInt(req.params.taskId);
  if (isNaN(jobId) || isNaN(taskId)) { res.status(400).json({ error: "Invalid id" }); return; }
  const [task] = await db
    .select()
    .from(jobTasksTable)
    .where(and(eq(jobTasksTable.jobId, jobId), eq(jobTasksTable.id, taskId)))
    .limit(1);
  if (!task) { res.status(404).json({ error: "Task not found" }); return; }
  res.json(task);
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
  const { name, scriptCode, targetRouterIds, targetGroupIds, excelData, autoConfirm, timeoutSeconds, retryCount, retryBackoffSeconds } = parsed.data;
  const [updated] = await db
    .update(batchJobsTable)
    .set({
      name,
      scriptCode,
      targetRouterIds: targetRouterIds ?? [],
      targetGroupIds: targetGroupIds ?? [],
      excelData: excelData as any,
      autoConfirm: autoConfirm ?? job.autoConfirm,
      timeoutSeconds: timeoutSeconds ?? job.timeoutSeconds,
      retryCount: retryCount ?? job.retryCount,
      retryBackoffSeconds: retryBackoffSeconds ?? job.retryBackoffSeconds,
    })
    .where(eq(batchJobsTable.id, id))
    .returning();
  res.json({ ...updated, completedAt: updated.completedAt ?? null });
});

// DELETE /jobs/:id — Delete a job, its tasks, and any schedules referencing it
// Cascading the schedule cleanup prevents orphan schedules pointing at a
// non-existent job. The response includes deletedSchedules so the UI can show
// a confirmation toast.
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
  // Cascade: remove any schedules that reference this job
  const removedSchedules = await db
    .delete(schedulesTable)
    .where(eq(schedulesTable.jobId, id))
    .returning({ id: schedulesTable.id });
  // Delete tasks first (child records), then the parent job
  await db.delete(jobTasksTable).where(eq(jobTasksTable.jobId, id));
  await db.delete(batchJobsTable).where(eq(batchJobsTable.id, id));
  res.json({ message: "Job deleted", deletedSchedules: removedSchedules.length });
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
      timeoutSeconds: sourceJob.timeoutSeconds,
      retryCount: sourceJob.retryCount,
      retryBackoffSeconds: sourceJob.retryBackoffSeconds,
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
    runJobInBackground(newJob.id, routers, sourceJob.scriptCode, sourceJob.excelData as Record<string, string>[] | undefined, sourceJob.autoConfirm, insertedTasks.map(t => t.id), { timeoutSeconds: sourceJob.timeoutSeconds, retryCount: sourceJob.retryCount, retryBackoffSeconds: sourceJob.retryBackoffSeconds })
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

// ─── Dry-run / preview ───────────────────────────────────────────────
// Resolves the targeted routers, applies tag substitution, and returns the
// per-device script that *would* run — without opening a single SSH session.
// Used by the "Preview" button on the new-job page so operators can verify
// substitutions before launching a destructive job.
router.post("/jobs/dry-run", async (req, res) => {
  requireAuth(req);
  const parsed = CreateJobBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request body" });
    return;
  }
  const { scriptCode, targetRouterIds, targetGroupIds, excelData } = parsed.data;
  const allRouterIds = await resolveRouterIds(targetRouterIds ?? [], targetGroupIds ?? []);
  if (allRouterIds.length === 0) { res.json([]); return; }
  const routers = await db
    .select({ id: routersTable.id, name: routersTable.name, ipAddress: routersTable.ipAddress })
    .from(routersTable)
    .where(inArray(routersTable.id, allRouterIds));

  const excelLookup = buildExcelLookup(excelData as Record<string, string>[] | undefined);
  const tagRe = /\{\{\s*([A-Za-z0-9_-]+)\s*\}\}/g;

  const result = routers.map((r, i) => {
    const row = findExcelRow(r as any, excelLookup, i, excelData as any);
    const resolvedScript = applyTagSubstitution(scriptCode, row);
    // Anything still in {{...}} after substitution is a tag we couldn't fill.
    const missingTags = Array.from(new Set(
      [...resolvedScript.matchAll(tagRe)].map((m) => m[1])
    ));
    return {
      routerId: r.id,
      routerName: r.name,
      routerIp: r.ipAddress,
      resolvedScript,
      missingTags,
    };
  });
  res.json(result);
});

// ─── Job result export ──────────────────────────────────────────────
// Exports completed task results in one of three shapes:
//  - csv: spreadsheet with device,status,duration,output
//  - txt: single concatenated text file with per-device sections
//  - zip: one .txt per device inside a zip archive
//
// We escape CSV fields by quoting and doubling embedded quotes — sufficient
// for the typical SSH command output, and avoids pulling in a heavy CSV
// library for one endpoint.
function csvField(s: string | null | undefined): string {
  const v = s == null ? "" : String(s);
  if (/[",\n]/.test(v)) return `"${v.replace(/"/g, '""')}"`;
  return v;
}

router.get("/jobs/:id/export", async (req, res) => {
  requireAuth(req);
  const id = parseInt(req.params.id);
  const format = String(req.query.format || "").toLowerCase();
  if (!["csv", "txt", "zip"].includes(format)) {
    res.status(400).json({ error: "format must be one of csv, txt, zip" });
    return;
  }
  const [job] = await db.select().from(batchJobsTable).where(eq(batchJobsTable.id, id)).limit(1);
  if (!job) { res.status(404).json({ error: "Job not found" }); return; }
  const tasks = await db
    .select()
    .from(jobTasksTable)
    .where(eq(jobTasksTable.jobId, id))
    .orderBy(jobTasksTable.id);

  const safeName = (job.name || `job-${id}`).replace(/[^a-zA-Z0-9._-]+/g, "_");

  if (format === "csv") {
    const header = "device,ip,status,duration_seconds,attempts,output,error";
    const lines = tasks.map((t) => {
      const dur = t.startedAt && t.completedAt
        ? Math.round((new Date(t.completedAt).getTime() - new Date(t.startedAt).getTime()) / 1000)
        : "";
      return [
        csvField(t.routerName),
        csvField(t.routerIp),
        csvField(t.status),
        csvField(String(dur)),
        csvField(String((t as any).attemptCount ?? 1)),
        csvField(t.output),
        csvField(t.errorMessage),
      ].join(",");
    });
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${safeName}.csv"`);
    res.send([header, ...lines].join("\n"));
    return;
  }

  if (format === "txt") {
    const sections = tasks.map((t) => {
      return [
        `=== ${t.routerName} (${t.routerIp}) — ${t.status} ===`,
        t.output || "(no output)",
        t.errorMessage ? `\nERROR: ${t.errorMessage}` : "",
        "",
      ].join("\n");
    });
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${safeName}.txt"`);
    res.send([
      `# Job: ${job.name}`,
      `# Status: ${job.status}`,
      `# Tasks: ${tasks.length}`,
      "",
      ...sections,
    ].join("\n"));
    return;
  }

  // zip: dynamically import jszip so it's only loaded when an export is requested
  const JSZip = (await import("jszip")).default;
  const zip = new JSZip();
  zip.file("README.txt", `Job: ${job.name}\nStatus: ${job.status}\nTasks: ${tasks.length}\n`);
  for (const t of tasks) {
    const fname = `${(t.routerName || `router-${t.routerId}`).replace(/[^a-zA-Z0-9._-]+/g, "_")}-${t.id}.txt`;
    zip.file(fname, [
      `Device: ${t.routerName} (${t.routerIp})`,
      `Status: ${t.status}`,
      `Attempts: ${(t as any).attemptCount ?? 1}`,
      "",
      "--- OUTPUT ---",
      t.output || "(none)",
      t.errorMessage ? `\n--- ERROR ---\n${t.errorMessage}` : "",
    ].join("\n"));
  }
  const buf = await zip.generateAsync({ type: "nodebuffer" });
  res.setHeader("Content-Type", "application/zip");
  res.setHeader("Content-Disposition", `attachment; filename="${safeName}.zip"`);
  res.send(buf);
});

export default router;
