// ─── Job Scheduler ──────────────────────────────────────────────────
// Background tick engine that polls every 30 seconds for due schedules.
// When a schedule fires, it clones the template job and runs SSH commands
// against all resolved routers (same execution logic as manual job runs).

import { db, schedulesTable, batchJobsTable, jobTasksTable, routersTable } from "@workspace/db";
import { eq, lte, and, inArray } from "drizzle-orm";
import { executeSSH, applyTagSubstitution } from "./ssh.js";
import { resolveRouterIds, buildExcelLookup, findExcelRow, runConcurrent } from "./resolve-routers.js";

// ─── Template Job Execution ─────────────────────────────────────────
// Clones a template job (status="scheduled") into a new running job,
// creates per-router tasks, and executes SSH commands sequentially.
// Used by interval and weekly schedules.
async function runJobFromTemplate(templateJob: typeof batchJobsTable.$inferSelect) {
  // Resolve all target routers from both direct IDs and group membership
  const allRouterIds = await resolveRouterIds(
    (templateJob.targetRouterIds as number[]) ?? [],
    (templateJob.targetGroupIds as number[]) ?? []
  );

  if (allRouterIds.length === 0) return;

  // Fetch router details and preserve the resolved ordering
  const routersUnordered = await db.select().from(routersTable).where(inArray(routersTable.id, allRouterIds));
  const routerMap = new Map(routersUnordered.map(r => [r.id, r]));
  const routers = allRouterIds.map(id => routerMap.get(id)!).filter(Boolean);

  // Create the new execution job (cloned from template)
  const [newJob] = await db.insert(batchJobsTable).values({
    name: `${templateJob.name} (scheduled)`,
    scriptCode: templateJob.scriptCode,
    status: "running",
    targetRouterIds: templateJob.targetRouterIds,
    targetGroupIds: templateJob.targetGroupIds,
    excelData: templateJob.excelData,
    autoConfirm: templateJob.autoConfirm,
    timeoutSeconds: templateJob.timeoutSeconds,
    retryCount: templateJob.retryCount,
    retryBackoffSeconds: templateJob.retryBackoffSeconds,
    totalTasks: routers.length,
    completedTasks: 0,
    failedTasks: 0,
    createdBy: templateJob.createdBy,
  }).returning();

  // Insert pending tasks for each router
  const tasks = routers.map(r => ({
    jobId: newJob.id,
    routerId: r.id,
    routerName: r.name,
    routerIp: r.ipAddress,
    status: "pending" as const,
  }));
  await db.insert(jobTasksTable).values(tasks);

  const insertedTasks = await db.select().from(jobTasksTable)
    .where(eq(jobTasksTable.jobId, newJob.id));
  const taskByRouterId = new Map(insertedTasks.map(t => [t.routerId, t.id]));

  const excelData = templateJob.excelData as Record<string, string>[] | undefined;
  const excelLookup = buildExcelLookup(excelData);
  let completedCount = 0;
  let failedCount = 0;

  await runConcurrent(routers, async (r, i) => {
    const taskId = taskByRouterId.get(r.id);
    if (!taskId) return;

    const row = findExcelRow(r, excelLookup, i, excelData);
    const finalScript = applyTagSubstitution(templateJob.scriptCode, row);

    await db.update(jobTasksTable).set({ status: "running", startedAt: new Date(), resolvedScript: finalScript }).where(eq(jobTasksTable.id, taskId));

    if (!r.sshPassword) {
      failedCount++;
      await db.update(jobTasksTable).set({
        status: "failed",
        errorMessage: "No SSH password configured",
        completedAt: new Date(),
      }).where(eq(jobTasksTable.id, taskId));
    } else {
      try {
        const result = await executeSSH(r.ipAddress, r.sshPort ?? 22, r.sshUsername, r.sshPassword, finalScript, {
          timeoutMs: (templateJob.timeoutSeconds || 30) * 1000,
          autoConfirm: templateJob.autoConfirm,
          enablePassword: r.enablePassword ?? undefined,
          retryCount: templateJob.retryCount || 0,
          retryBackoffSeconds: templateJob.retryBackoffSeconds || 5,
        });
        if (result.success) {
          completedCount++;
          await db.update(jobTasksTable).set({
            status: "success", output: result.output, connectionLog: result.connectionLog, attemptCount: result.attemptCount, completedAt: new Date(),
          }).where(eq(jobTasksTable.id, taskId));
        } else {
          failedCount++;
          await db.update(jobTasksTable).set({
            status: "failed", output: result.output, errorMessage: result.errorMessage, connectionLog: result.connectionLog, attemptCount: result.attemptCount, completedAt: new Date(),
          }).where(eq(jobTasksTable.id, taskId));
        }
      } catch (err: any) {
        failedCount++;
        await db.update(jobTasksTable).set({
          status: "failed", errorMessage: err.message, completedAt: new Date(),
        }).where(eq(jobTasksTable.id, taskId));
      }
    }

    await db.update(batchJobsTable).set({
      completedTasks: completedCount,
      failedTasks: failedCount,
    }).where(eq(batchJobsTable.id, newJob.id));
  }, 10);

  // Finalize the job — "failed" only if every single task failed
  await db.update(batchJobsTable).set({
    status: failedCount === routers.length ? "failed" : "completed",
    completedAt: new Date(),
    completedTasks: completedCount,
    failedTasks: failedCount,
  }).where(eq(batchJobsTable.id, newJob.id));
}

function getNthWeekdayOfMonth(year: number, month: number, nth: number, weekday: number): Date | null {
  const firstDay = new Date(year, month, 1);
  let firstOccurrence = firstDay.getDate() + ((weekday - firstDay.getDay() + 7) % 7);
  const target = firstOccurrence + (nth - 1) * 7;
  const lastDay = new Date(year, month + 1, 0).getDate();
  if (target > lastDay) return null;
  return new Date(year, month, target);
}

function computeNextRun(schedule: typeof schedulesTable.$inferSelect): Date | null {
  if (schedule.type === "once") {
    return null;
  }

  const now = new Date();

  if (schedule.type === "interval" && schedule.intervalMinutes) {
    return new Date(now.getTime() + schedule.intervalMinutes * 60 * 1000);
  }

  if (schedule.type === "daily" && schedule.timeOfDay) {
    const [hours, minutes] = schedule.timeOfDay.split(":").map(Number);
    const today = new Date(now);
    today.setHours(hours, minutes, 0, 0);
    if (today > now) return today;
    const tomorrow = new Date(now);
    tomorrow.setDate(tomorrow.getDate() + 1);
    tomorrow.setHours(hours, minutes, 0, 0);
    return tomorrow;
  }

  if (schedule.type === "weekly" && schedule.daysOfWeek && schedule.timeOfDay) {
    const [hours, minutes] = schedule.timeOfDay.split(":").map(Number);
    const days = schedule.daysOfWeek as number[];
    for (let offset = 0; offset <= 7; offset++) {
      const candidate = new Date(now);
      candidate.setDate(candidate.getDate() + offset);
      candidate.setHours(hours, minutes, 0, 0);
      if (candidate > now && days.includes(candidate.getDay())) {
        return candidate;
      }
    }
    const candidate = new Date(now);
    candidate.setDate(candidate.getDate() + 7);
    candidate.setHours(hours, minutes, 0, 0);
    return candidate;
  }

  if (schedule.type === "monthly" && schedule.monthlyMode && schedule.timeOfDay) {
    const [hours, minutes] = schedule.timeOfDay.split(":").map(Number);
    if (schedule.monthlyMode === "dayOfMonth" && schedule.dayOfMonth) {
      for (let mo = 0; mo <= 12; mo++) {
        const c = new Date(now.getFullYear(), now.getMonth() + mo, 1);
        const lastDay = new Date(c.getFullYear(), c.getMonth() + 1, 0).getDate();
        c.setDate(Math.min(schedule.dayOfMonth, lastDay));
        c.setHours(hours, minutes, 0, 0);
        if (c > now) return c;
      }
    }
    if (schedule.monthlyMode === "nthWeekday" && schedule.nthWeek && schedule.nthWeekday !== null && schedule.nthWeekday !== undefined) {
      for (let mo = 0; mo <= 12; mo++) {
        const c = getNthWeekdayOfMonth(now.getFullYear(), now.getMonth() + mo, schedule.nthWeek, schedule.nthWeekday);
        if (c) {
          c.setHours(hours, minutes, 0, 0);
          if (c > now) return c;
        }
      }
    }
    const fallback = new Date(now);
    fallback.setMonth(fallback.getMonth() + 1);
    fallback.setHours(hours, minutes, 0, 0);
    return fallback;
  }

  return null;
}

// ─── Scheduler Tick ─────────────────────────────────────────────────
// Runs once per interval. Finds all enabled schedules whose nextRunAt is past due,
// then executes each one. One-time schedules run the template job in-place;
// interval/weekly schedules clone it via runJobFromTemplate.
async function tick() {
  try {
    const now = new Date();
    // Find all schedules that are enabled and past their next run time
    const due = await db.select().from(schedulesTable)
      .where(and(
        eq(schedulesTable.enabled, true),
        lte(schedulesTable.nextRunAt, now)
      ));

    for (const schedule of due) {
      // Look up the template job this schedule is bound to
      const [templateJob] = await db.select().from(batchJobsTable)
        .where(eq(batchJobsTable.id, schedule.jobId))
        .limit(1);

      // If the template was deleted, disable this schedule
      if (!templateJob) {
        await db.update(schedulesTable).set({ enabled: false }).where(eq(schedulesTable.id, schedule.id));
        continue;
      }

      console.log(`[Scheduler] Running schedule "${schedule.name}" (id=${schedule.id})`);

      if (schedule.type === "once") {
        // One-time: execute the template job in-place (convert it from "scheduled" to "running")
        if (templateJob.status === "scheduled") {
          await db.update(batchJobsTable).set({ status: "running" }).where(eq(batchJobsTable.id, templateJob.id));

          const allRouterIds = await resolveRouterIds(
            (templateJob.targetRouterIds as number[]) ?? [],
            (templateJob.targetGroupIds as number[]) ?? []
          );
          const routersUnordered = await db.select().from(routersTable).where(inArray(routersTable.id, allRouterIds));
          const routerMap = new Map(routersUnordered.map(r => [r.id, r]));
          const routers = allRouterIds.map(id => routerMap.get(id)!).filter(Boolean);

          await db.update(batchJobsTable).set({ totalTasks: routers.length }).where(eq(batchJobsTable.id, templateJob.id));

          const tasks = routers.map(r => ({
            jobId: templateJob.id,
            routerId: r.id,
            routerName: r.name,
            routerIp: r.ipAddress,
            status: "pending" as const,
          }));
          if (tasks.length > 0) await db.insert(jobTasksTable).values(tasks);

          // Sequential SSH execution (same logic as runJobFromTemplate)
          const excelData = templateJob.excelData as Record<string, string>[] | undefined;
          const excelLookup = buildExcelLookup(excelData);
          let completedCount = 0;
          let failedCount = 0;

          for (let i = 0; i < routers.length; i++) {
            const r = routers[i];
            const [task] = await db.select({ id: jobTasksTable.id }).from(jobTasksTable)
              .where(and(eq(jobTasksTable.jobId, templateJob.id), eq(jobTasksTable.routerId, r.id)))
              .limit(1);
            if (!task) continue;

            const row = findExcelRow(r, excelLookup, i, excelData);
            const finalScript = applyTagSubstitution(templateJob.scriptCode, row);

            await db.update(jobTasksTable).set({ status: "running", startedAt: new Date(), resolvedScript: finalScript }).where(eq(jobTasksTable.id, task.id));

            if (!r.sshPassword) {
              failedCount++;
              await db.update(jobTasksTable).set({
                status: "failed", errorMessage: "No SSH password configured", completedAt: new Date(),
              }).where(eq(jobTasksTable.id, task.id));
              await db.update(batchJobsTable).set({ failedTasks: failedCount }).where(eq(batchJobsTable.id, templateJob.id));
              continue;
            }

            try {
              const result = await executeSSH(r.ipAddress, r.sshPort ?? 22, r.sshUsername, r.sshPassword, finalScript, {
                timeoutMs: (templateJob.timeoutSeconds || 30) * 1000,
                autoConfirm: templateJob.autoConfirm,
                enablePassword: r.enablePassword ?? undefined,
                retryCount: templateJob.retryCount || 0,
                retryBackoffSeconds: templateJob.retryBackoffSeconds || 5,
              });
              if (result.success) { completedCount++; await db.update(jobTasksTable).set({ status: "success", output: result.output, connectionLog: result.connectionLog, attemptCount: result.attemptCount, completedAt: new Date() }).where(eq(jobTasksTable.id, task.id)); }
              else { failedCount++; await db.update(jobTasksTable).set({ status: "failed", output: result.output, errorMessage: result.errorMessage, connectionLog: result.connectionLog, attemptCount: result.attemptCount, completedAt: new Date() }).where(eq(jobTasksTable.id, task.id)); }
            } catch (err: any) {
              failedCount++;
              await db.update(jobTasksTable).set({ status: "failed", errorMessage: err.message, completedAt: new Date() }).where(eq(jobTasksTable.id, task.id));
            }
            await db.update(batchJobsTable).set({ completedTasks: completedCount, failedTasks: failedCount }).where(eq(batchJobsTable.id, templateJob.id));
          }

          await db.update(batchJobsTable).set({
            status: failedCount === routers.length ? "failed" : "completed",
            completedAt: new Date(), completedTasks: completedCount, failedTasks: failedCount,
          }).where(eq(batchJobsTable.id, templateJob.id));
        }

        // Disable one-time schedule after it fires
        await db.update(schedulesTable).set({
          enabled: false, lastRunAt: new Date(), nextRunAt: null, runCount: schedule.runCount + 1,
        }).where(eq(schedulesTable.id, schedule.id));
      } else {
        // Interval/weekly: clone the template into a new job and execute
        await runJobFromTemplate(templateJob);
        const nextRun = computeNextRun(schedule);
        await db.update(schedulesTable).set({
          lastRunAt: new Date(),
          nextRunAt: nextRun,
          runCount: schedule.runCount + 1,
          enabled: nextRun !== null,  // Disable if no valid next run (shouldn't happen for interval/weekly)
        }).where(eq(schedulesTable.id, schedule.id));
      }
    }
  } catch (err) {
    console.error("[Scheduler] Error:", err);
  }
}

// ─── Scheduler Lifecycle ────────────────────────────────────────────

let intervalHandle: ReturnType<typeof setInterval> | null = null;
let tickInFlight = false;  // Prevents overlapping ticks if a run takes longer than 30s

// Wrapper that skips the tick if the previous one is still running
async function safeTick() {
  if (tickInFlight) {
    console.log("[Scheduler] Skipping tick (previous still running)");
    return;
  }
  tickInFlight = true;
  try {
    await tick();
  } finally {
    tickInFlight = false;
  }
}

// Start the scheduler loop — called once at server startup
export function startScheduler() {
  if (intervalHandle) return;
  console.log("[Scheduler] Started (checking every 30s)");
  intervalHandle = setInterval(safeTick, 30_000);
  safeTick(); // Run immediately on startup to catch any overdue schedules
}

// Stop the scheduler loop (used during graceful shutdown)
export function stopScheduler() {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
  }
}
