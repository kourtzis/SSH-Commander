// ─── Job Scheduler ──────────────────────────────────────────────────
// Background tick engine that polls every 30 seconds for due schedules.
// When a schedule fires, it clones the template job and runs SSH commands
// against all resolved routers (same execution logic as manual job runs).

import { db, pool, schedulesTable, batchJobsTable, jobTasksTable, routersTable } from "@workspace/db";
import { eq, lte, and, inArray } from "drizzle-orm";
import type { PoolClient } from "pg";
import { executeSSH, applyTagSubstitution, detectFailureSignals } from "./ssh.js";
import { resolveRouterIds, buildExcelLookup, findExcelRow, runConcurrent } from "./resolve-routers.js";
import { resolveEffectiveCreds } from "./effective-creds.js";
import { computeNextRun } from "./schedule-math.js";
import { childLogger } from "./logger.js";

const log = childLogger("scheduler");

// ─── Shared SSH execution helper ────────────────────────────────────
// Runs the SSH commands for every router of a job in parallel (bounded
// concurrency = 20), updating per-task and per-job rows as it goes.
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
            autoConfirm: options.autoConfirm ?? undefined,
            enablePassword: creds.enablePassword,
            jumpHost: creds.jumpHost,
            useLegacyAlgorithms: creds.useLegacyAlgorithms,
            retryCount: options.retryCount || 0,
            retryBackoffSeconds: options.retryBackoffSeconds || 5,
            hostKeyTrust: { routerId: r.id, expectedFingerprint: (r as any).sshHostKeyFingerprint ?? null },
            // When the auto-confirm shell sees an unrecognised prompt
            // it parks the live SSH session and calls onPark so we can
            // flip the task to waiting_input. The awaited promise
            // stays unresolved until the operator submits input (or
            // the parked session is aborted), so completed/failed
            // counters do not move while waiting.
            taskContext: options.autoConfirm !== false
              ? { taskId, jobId, routerId: r.id, routerName: r.name, routerIp: r.ipAddress }
              : undefined,
            onPark: async ({ taskId: tid, promptText }) => {
              await db.update(jobTasksTable).set({
                status: "waiting_input",
                promptText,
              }).where(eq(jobTasksTable.id, tid));
            },
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
  }, 20);

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

  // Atomic clone: create the parent batch_jobs row + all child job_tasks in
  // one transaction. Without this, a crash between the two inserts (or a
  // pool-eviction-induced disconnect) would leave a "running" job with zero
  // tasks — visible in the UI as a perpetually 0/N progress bar that the
  // operator can never resolve. The transaction ensures both rows exist or
  // neither does (a retry on the next scheduler tick would then start
  // cleanly because the orphan parent was never committed).
  const newJob = await db.transaction(async (tx) => {
    const [created] = await tx.insert(batchJobsTable).values({
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
    if (routers.length > 0) {
      await tx.insert(jobTasksTable).values(routers.map((r: any) => ({
        jobId: created.id,
        routerId: r.id,
        routerName: r.name,
        routerIp: r.ipAddress,
        status: "pending" as const,
      })));
    }
    return created;
  });

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

      log.info({ scheduleId: schedule.id, name: schedule.name }, "Running schedule");

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
    log.error({ err }, "tick error");
  }
}

// ─── Scheduler Lifecycle ────────────────────────────────────────────

let intervalHandle: ReturnType<typeof setInterval> | null = null;
let tickInFlight = false;  // Prevents overlapping ticks if a run takes longer than 30s

// Postgres advisory-lock key for the scheduler tick. A 32-bit integer is
// fine; the value itself is arbitrary as long as no other process in the
// same database uses it for a different purpose. 0x55h is "U" (for "Update
// schedules") — picked just to be visibly meaningful in pg_locks output.
const SCHEDULER_LOCK_KEY = 0x55_43_4d_44; // "UCMD"

async function safeTick() {
  // In-process guard: skip if a previous tick is still running on THIS
  // instance. Cheap and short-circuits before we touch the DB.
  if (tickInFlight) {
    log.debug("Skipping tick (previous still running)");
    return;
  }
  tickInFlight = true;

  // Cross-instance guard: when SSH Commander runs with multiple API server
  // replicas (HA / rolling deploy), without this every replica would race on
  // the same due schedules and clone the template job N times.
  //
  // We hold a *session-scoped* advisory lock on a single dedicated pooled
  // connection for the lifetime of the tick, and release it on that SAME
  // connection in finally. This is the key change from the earlier
  // transaction-scoped approach: a tick can run for minutes (SSH to hundreds
  // of devices), and wrapping it in a transaction created a minutes-long
  // idle-in-transaction connection that held back autovacuum (xmin horizon)
  // and could be killed by an `idle_in_transaction_session_timeout`, aborting
  // the run. Acquiring and releasing the lock on the same pinned client keeps
  // it safe under pooling (the unlock can never land on a different backend)
  // while tick()'s own queries run on the regular pool — the lock is a
  // coordination primitive, not a data fence, so it does NOT wrap tick's work
  // in a transaction.
  // client is acquired INSIDE the try so that a failure in pool.connect()
  // (DB outage, pool exhaustion) still falls through to the finally that
  // resets tickInFlight — otherwise a single failed connect would wedge the
  // in-process guard and silently disable scheduling on this instance forever.
  let client: PoolClient | null = null;
  let locked = false;
  try {
    client = await pool.connect();
    const lockResult = await client.query<{ locked: boolean }>(
      "select pg_try_advisory_lock($1) as locked",
      [SCHEDULER_LOCK_KEY],
    );
    locked = lockResult.rows[0]?.locked === true;
    if (!locked) {
      log.debug("Skipping tick (advisory lock held by another instance)");
      return;
    }
    await tick();
  } catch (err) {
    log.error({ err }, "tick failed");
  } finally {
    if (client) {
      if (locked) {
        try {
          await client.query("select pg_advisory_unlock($1)", [SCHEDULER_LOCK_KEY]);
        } catch (err) {
          log.warn({ err }, "advisory unlock failed");
        }
      }
      client.release();
    }
    tickInFlight = false;
  }
}

export function startScheduler() {
  if (intervalHandle) return;
  log.info("Started (checking every 30s)");
  intervalHandle = setInterval(safeTick, 30_000);
  safeTick();
}

export function stopScheduler() {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
  }
}
