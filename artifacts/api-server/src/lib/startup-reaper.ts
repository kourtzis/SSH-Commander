// ─── Startup Reaper ─────────────────────────────────────────────────
// Interactive sessions and the parked-prompt registry live only in memory
// (interactive-session.ts, stuck-prompts.ts). When the process restarts —
// Docker stop, k8s rolling deploy, a crash, or a manual workflow restart —
// those SSH streams die, but the database rows that tracked them are left
// in a non-terminal state forever. The UI then shows dead sessions as
// "running" / "waiting for input" with no way to clear them, and the jobs
// list shows perpetual "running" jobs that will never finish.
//
// On boot we sweep the database once and fail anything that was mid-flight,
// because nothing resumes an interrupted in-memory job: there is no startup
// path that re-drives pending/running/waiting_input tasks.
//
// Scheduling note: recurring schedules (interval/daily/weekly/monthly) clone
// a brand-new batch_jobs row per run and leave the template at status
// "scheduled", so reaping status="running" never touches a recurring
// template. A "once" template that was transiently "running" at restart is a
// genuine unrecoverable orphan and is correctly failed here.

import { db, batchJobsTable, jobTasksTable } from "@workspace/db";
import { inArray } from "drizzle-orm";
import { childLogger } from "./logger.js";

const log = childLogger("startup-reaper");

const INTERRUPTED = "Interrupted by server restart";

export async function reapOrphanedJobs(): Promise<void> {
  try {
    // 1. Fail orphaned per-router tasks (pending/running/waiting_input).
    const failedTasks = await db
      .update(jobTasksTable)
      .set({
        status: "failed",
        errorMessage: INTERRUPTED,
        promptText: null,
        completedAt: new Date(),
      })
      .where(inArray(jobTasksTable.status, ["pending", "running", "waiting_input"]))
      .returning({ id: jobTasksTable.id });

    // 2. Fail the parent jobs that were still running. Recurring schedule
    //    templates stay "scheduled" and are untouched.
    const failedJobs = await db
      .update(batchJobsTable)
      .set({ status: "failed", completedAt: new Date() })
      .where(inArray(batchJobsTable.status, ["running"]))
      .returning({ id: batchJobsTable.id });

    if (failedTasks.length > 0 || failedJobs.length > 0) {
      log.info(
        { tasks: failedTasks.length, jobs: failedJobs.length },
        "Reaped orphaned tasks/jobs left non-terminal by a previous shutdown",
      );
    }
  } catch (err) {
    // Never block startup on the reaper — a failure here just means stale
    // rows linger until the next restart, which is strictly better than the
    // server refusing to come up.
    log.error({ err }, "Startup reaper failed");
  }
}
