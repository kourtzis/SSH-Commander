// ─── Job Scheduler ──────────────────────────────────────────────────
// Background tick engine that polls every 30 seconds for due schedules.
// When a schedule fires, it clones the template job and runs SSH commands
// against all resolved routers (same execution logic as manual job runs).

import { db, schedulesTable, batchJobsTable, jobTasksTable, routersTable } from "@workspace/db";
import { eq, lte, and, inArray } from "drizzle-orm";
import { executeSSH, applyTagSubstitution, detectFailureSignals } from "./ssh.js";
import { resolveRouterIds, buildExcelLookup, findExcelRow, runConcurrent } from "./resolve-routers.js";
import { resolveEffectiveCreds } from "./effective-creds.js";

// ─── Shared SSH execution helper ────────────────────────────────────
// Runs the SSH commands for every router of a job in parallel (bounded
// concurrency = 10), updating per-task and per-job rows as it goes.
// Used by both runJobFromTemplate (interval/weekly clones) and the one-time
// path in tick() — they used to be near-duplicates with the one-time path
// running sequentially; sharing this helper makes them identical and parallel.
async function executeJobTasks(
  jobId: number,
  routers: typeof routersTable.$inferSelect[],
  scriptCode: string,
  excelData: Record<string, string>[] | undefined,
  options: { timeoutSeconds: number | null; autoConfirm: boolean | null; retryCount: number | null; retryBackoffSeconds: number | null }
) {
  // Bulk-load all this job's tasks once instead of one SELECT per router
  // inside the loop (was the v1.7.x scheduler hot-spot for big jobs).
  const insertedTasks = await db
    .select({ id: jobTasksTable.id, routerId: jobTasksTable.routerId })
    .from(jobTasksTable)
    .where(eq(jobTasksTable.jobId, jobId));
  const taskByRouterId = new Map(insertedTasks.map((t) => [t.routerId, t.id]));

  const excelLookup = buildExcelLookup(excelData);
  let completedCount = 0;
  let failedCount = 0;

  await runConcurrent(routers, async (r, i) => {
    const taskId = taskByRouterId.get(r.id);
    if (!taskId) return;

    const row = findExcelRow(r, excelLookup, i, excelData);
    const finalScript = applyTagSubstitution(scriptCode, row);

    await db.update(jobTasksTable).set({
      status: "running",
      startedAt: new Date(),
      resolvedScript: finalScript,
    }).where(eq(jobTasksTable.id, taskId));

    // Resolve creds via the shared helper so scheduled jobs honour
    // credential profiles + bastion routing the same as ad-hoc runs.
    const creds = await resolveEffectiveCreds(r as any);
    if (!creds.password) {
      failedCount++;
      await db.update(jobTasksTable).set({
        status: "failed",
        errorMessage: "No SSH password configured (check the credential profile or set an inline password)",
        completedAt: new Date(),
      }).where(eq(jobTasksTable.id, taskId));
    } else {
      try {
        const result = await executeSSH(
          r.ipAddress, r.sshPort ?? 22, creds.username, creds.password, finalScript,
          {
            timeoutMs: (options.timeoutSeconds || 30) * 1000,
            autoConfirm: options.autoConfirm,
            enablePassword: creds.enablePassword,
            jumpHost: creds.jumpHost,
            retryCount: options.retryCount || 0,
            retryBackoffSeconds: options.retryBackoffSeconds || 5,
            hostKeyTrust: { routerId: r.id, expectedFingerprint: (r as any).sshHostKeyFingerprint ?? null },
          }
        );
        if (result.success) {
          // SSH itself succeeded — but check the device output for failure
          // signals. If any are present the task is marked needs_attention
          // (still counts toward failedTasks so the job badge doesn't
          // falsely show fully successful when devices logically failed).
          const signal = detectFailureSignals(result.output);
          if (signal) {
            failedCount++;
            await db.update(jobTasksTable).set({
              status: "needs_attention",
              output: result.output,
              connectionLog: result.connectionLog,
              attemptCount: result.attemptCount,
              failureReason: `Detected "${signal.word}"${signal.matchedCount > 1 ? ` (+${signal.matchedCount - 1} more signal${signal.matchedCount - 1 === 1 ? "" : "s"})` : ""} in output: ${signal.line.slice(0, 240)}`,
              completedAt: new Date(),
            }).where(eq(jobTasksTable.id, taskId));
          } else {
            completedCount++;
            await db.update(jobTasksTable).set({
              status: "success",
              output: result.output,
              connectionLog: result.connectionLog,
              attemptCount: result.attemptCount,
              completedAt: new Date(),
            }).where(eq(jobTasksTable.id, taskId));
          }
        } else {
          failedCount++;
          await db.update(jobTasksTable).set({
            status: "failed",
            output: result.output,
            errorMessage: result.errorMessage,
            connectionLog: result.connectionLog,
            attemptCount: result.attemptCount,
            completedAt: new Date(),
          }).where(eq(jobTasksTable.id, taskId));
        }
      } catch (err: any) {
        failedCount++;
        await db.update(jobTasksTable).set({
          status: "failed",
          errorMessage: err.message,
          completedAt: new Date(),
        }).where(eq(jobTasksTable.id, taskId));
      }
    }

    await db.update(batchJobsTable).set({
      completedTasks: completedCount,
      failedTasks: failedCount,
    }).where(eq(batchJobsTable.id, jobId));
  }, 10);

  return { completedCount, failedCount };
}

// Tighten the routers SELECT — we only need the columns relevant to SSH
// execution (no description, createdAt, vendor, etc.). Cuts row size when
// loading hundreds of devices for a scheduled job.
const SSH_ROUTER_COLUMNS = {
  id: routersTable.id,
  name: routersTable.name,
  ipAddress: routersTable.ipAddress,
  sshPort: routersTable.sshPort,
  sshUsername: routersTable.sshUsername,
  sshPassword: routersTable.sshPassword,
  enablePassword: routersTable.enablePassword,
  // Needed for TOFU host-key verification on every connection.
  sshHostKeyFingerprint: routersTable.sshHostKeyFingerprint,
  // Required so resolveEffectiveCreds() can pull profile + jump-host data
  // for scheduled runs — without this, scheduler bypasses credential
  // profiles entirely and only inline creds work.
  credentialProfileId: routersTable.credentialProfileId,
} as const;

// ─── Template Job Execution ─────────────────────────────────────────
// Clones a template job (status="scheduled") into a new running job,
// creates per-router tasks, and executes SSH commands in parallel.
// Used by interval / daily / weekly / monthly schedules.
async function runJobFromTemplate(templateJob: typeof batchJobsTable.$inferSelect) {
  const allRouterIds = await resolveRouterIds(
    (templateJob.targetRouterIds as number[]) ?? [],
    (templateJob.targetGroupIds as number[]) ?? []
  );

  if (allRouterIds.length === 0) return;

  const routersUnordered = await db
    .select(SSH_ROUTER_COLUMNS)
    .from(routersTable)
    .where(inArray(routersTable.id, allRouterIds));
  const routerMap = new Map(routersUnordered.map((r) => [r.id, r]));
  const routers = allRouterIds.map((id) => routerMap.get(id)!).filter(Boolean) as any;

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

  await db.insert(jobTasksTable).values(routers.map((r: any) => ({
    jobId: newJob.id,
    routerId: r.id,
    routerName: r.name,
    routerIp: r.ipAddress,
    status: "pending" as const,
  })));

  const excelData = templateJob.excelData as Record<string, string>[] | undefined;
  const { completedCount, failedCount } = await executeJobTasks(
    newJob.id, routers, templateJob.scriptCode, excelData,
    {
      timeoutSeconds: templateJob.timeoutSeconds,
      autoConfirm: templateJob.autoConfirm,
      retryCount: templateJob.retryCount,
      retryBackoffSeconds: templateJob.retryBackoffSeconds,
    }
  );

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
// Runs once per interval. Finds all enabled schedules whose nextRunAt is past
// due, then executes each one. One-time schedules run the template job
// in-place; interval / daily / weekly / monthly schedules clone it via
// runJobFromTemplate.
async function tick() {
  try {
    const now = new Date();
    const due = await db.select().from(schedulesTable)
      .where(and(
        eq(schedulesTable.enabled, true),
        lte(schedulesTable.nextRunAt, now)
      ));
    if (due.length === 0) return;

    // Bulk-fetch every template job referenced by the due schedules in one
    // query instead of one SELECT per schedule (was N+1 in 1.7.x).
    const templateJobIds = Array.from(new Set(due.map((s) => s.jobId)));
    const templates = await db.select().from(batchJobsTable)
      .where(inArray(batchJobsTable.id, templateJobIds));
    const templateById = new Map(templates.map((t) => [t.id, t]));

    for (const schedule of due) {
      const templateJob = templateById.get(schedule.jobId);

      // If the template was deleted, disable this schedule
      if (!templateJob) {
        await db.update(schedulesTable).set({ enabled: false }).where(eq(schedulesTable.id, schedule.id));
        continue;
      }

      console.log(`[Scheduler] Running schedule "${schedule.name}" (id=${schedule.id})`);

      if (schedule.type === "once") {
        if (templateJob.status === "scheduled") {
          await db.update(batchJobsTable).set({ status: "running" }).where(eq(batchJobsTable.id, templateJob.id));

          const allRouterIds = await resolveRouterIds(
            (templateJob.targetRouterIds as number[]) ?? [],
            (templateJob.targetGroupIds as number[]) ?? []
          );
          const routersUnordered = await db
            .select(SSH_ROUTER_COLUMNS)
            .from(routersTable)
            .where(inArray(routersTable.id, allRouterIds));
          const routerMap = new Map(routersUnordered.map((r) => [r.id, r]));
          const routers = allRouterIds.map((id) => routerMap.get(id)!).filter(Boolean) as any;

          await db.update(batchJobsTable).set({ totalTasks: routers.length }).where(eq(batchJobsTable.id, templateJob.id));

          if (routers.length > 0) {
            await db.insert(jobTasksTable).values(routers.map((r: any) => ({
              jobId: templateJob.id,
              routerId: r.id,
              routerName: r.name,
              routerIp: r.ipAddress,
              status: "pending" as const,
            })));
          }

          // Run all tasks in parallel via the shared helper (was sequential
          // before — a 50-device one-time schedule would block the scheduler
          // tick for minutes).
          const excelData = templateJob.excelData as Record<string, string>[] | undefined;
          const { completedCount, failedCount } = await executeJobTasks(
            templateJob.id, routers, templateJob.scriptCode, excelData,
            {
              timeoutSeconds: templateJob.timeoutSeconds,
              autoConfirm: templateJob.autoConfirm,
              retryCount: templateJob.retryCount,
              retryBackoffSeconds: templateJob.retryBackoffSeconds,
            }
          );

          await db.update(batchJobsTable).set({
            status: failedCount === routers.length ? "failed" : "completed",
            completedAt: new Date(),
            completedTasks: completedCount,
            failedTasks: failedCount,
          }).where(eq(batchJobsTable.id, templateJob.id));
        }

        // Disable one-time schedule after it fires
        await db.update(schedulesTable).set({
          enabled: false, lastRunAt: new Date(), nextRunAt: null, runCount: schedule.runCount + 1,
        }).where(eq(schedulesTable.id, schedule.id));
      } else {
        await runJobFromTemplate(templateJob);
        const nextRun = computeNextRun(schedule);
        await db.update(schedulesTable).set({
          lastRunAt: new Date(),
          nextRunAt: nextRun,
          runCount: schedule.runCount + 1,
          enabled: nextRun !== null,
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

export function startScheduler() {
  if (intervalHandle) return;
  console.log("[Scheduler] Started (checking every 30s)");
  intervalHandle = setInterval(safeTick, 30_000);
  safeTick();
}

export function stopScheduler() {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
  }
}
