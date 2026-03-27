import { db, schedulesTable, batchJobsTable, jobTasksTable, routersTable } from "@workspace/db";
import { eq, lte, and, inArray } from "drizzle-orm";
import { executeSSHCommand, applyTagSubstitution } from "./ssh.js";

async function resolveRouterIds(
  directRouterIds: number[],
  groupIds: number[]
): Promise<number[]> {
  const { groupRoutersTable, groupSubgroupsTable } = await import("@workspace/db");
  const seen = new Set<number>();
  const ordered: number[] = [];
  function addUnique(id: number) {
    if (!seen.has(id)) { seen.add(id); ordered.push(id); }
  }
  for (const id of directRouterIds) addUnique(id);

  const visited = new Set<number>();
  async function resolveGroups(gids: number[]) {
    for (const gid of gids) {
      if (visited.has(gid)) continue;
      visited.add(gid);
      const links = await db.select().from(groupRoutersTable).where(eq(groupRoutersTable.groupId, gid));
      for (const l of links) addUnique(l.routerId);
      const subs = await db.select().from(groupSubgroupsTable).where(eq(groupSubgroupsTable.parentGroupId, gid));
      if (subs.length > 0) await resolveGroups(subs.map(s => s.childGroupId));
    }
  }
  await resolveGroups(groupIds);
  return ordered;
}

function buildExcelLookup(excelData: Record<string, string>[] | undefined): Map<string, Record<string, string>> | null {
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
  if (excelData && excelData.length > 0) return excelData[index] ?? excelData[excelData.length - 1];
  return {};
}

async function runJobFromTemplate(templateJob: typeof batchJobsTable.$inferSelect) {
  const allRouterIds = await resolveRouterIds(
    (templateJob.targetRouterIds as number[]) ?? [],
    (templateJob.targetGroupIds as number[]) ?? []
  );

  if (allRouterIds.length === 0) return;

  const routersUnordered = await db.select().from(routersTable).where(inArray(routersTable.id, allRouterIds));
  const routerMap = new Map(routersUnordered.map(r => [r.id, r]));
  const routers = allRouterIds.map(id => routerMap.get(id)!).filter(Boolean);

  const [newJob] = await db.insert(batchJobsTable).values({
    name: `${templateJob.name} (scheduled)`,
    scriptCode: templateJob.scriptCode,
    status: "running",
    targetRouterIds: templateJob.targetRouterIds,
    targetGroupIds: templateJob.targetGroupIds,
    excelData: templateJob.excelData,
    autoConfirm: templateJob.autoConfirm,
    totalTasks: routers.length,
    completedTasks: 0,
    failedTasks: 0,
    createdBy: templateJob.createdBy,
  }).returning();

  const tasks = routers.map(r => ({
    jobId: newJob.id,
    routerId: r.id,
    routerName: r.name,
    routerIp: r.ipAddress,
    status: "pending" as const,
  }));
  await db.insert(jobTasksTable).values(tasks);

  const excelData = templateJob.excelData as Record<string, string>[] | undefined;
  const excelLookup = buildExcelLookup(excelData);
  let completedCount = 0;
  let failedCount = 0;

  for (let i = 0; i < routers.length; i++) {
    const r = routers[i];
    const [task] = await db.select().from(jobTasksTable)
      .where(and(eq(jobTasksTable.jobId, newJob.id), eq(jobTasksTable.routerId, r.id)))
      .limit(1);
    if (!task) continue;

    await db.update(jobTasksTable).set({ status: "running", startedAt: new Date() }).where(eq(jobTasksTable.id, task.id));

    const row = findExcelRow(r, excelLookup, i, excelData);
    const finalScript = applyTagSubstitution(templateJob.scriptCode, row);
    await db.update(jobTasksTable).set({ resolvedScript: finalScript }).where(eq(jobTasksTable.id, task.id));

    if (!r.sshPassword) {
      failedCount++;
      await db.update(jobTasksTable).set({
        status: "failed",
        errorMessage: "No SSH password configured",
        completedAt: new Date(),
      }).where(eq(jobTasksTable.id, task.id));
      await db.update(batchJobsTable).set({ failedTasks: failedCount }).where(eq(batchJobsTable.id, newJob.id));
      continue;
    }

    try {
      const result = await executeSSHCommand(r.ipAddress, r.sshPort ?? 22, r.sshUsername, r.sshPassword, finalScript, 30000, templateJob.autoConfirm);
      if (result.success) {
        completedCount++;
        await db.update(jobTasksTable).set({
          status: "success", output: result.output, connectionLog: result.connectionLog, completedAt: new Date(),
        }).where(eq(jobTasksTable.id, task.id));
      } else {
        failedCount++;
        await db.update(jobTasksTable).set({
          status: "failed", output: result.output, errorMessage: result.errorMessage, connectionLog: result.connectionLog, completedAt: new Date(),
        }).where(eq(jobTasksTable.id, task.id));
      }
    } catch (err: any) {
      failedCount++;
      await db.update(jobTasksTable).set({
        status: "failed", errorMessage: err.message, completedAt: new Date(),
      }).where(eq(jobTasksTable.id, task.id));
    }

    await db.update(batchJobsTable).set({
      completedTasks: completedCount,
      failedTasks: failedCount,
    }).where(eq(batchJobsTable.id, newJob.id));
  }

  await db.update(batchJobsTable).set({
    status: failedCount === routers.length ? "failed" : "completed",
    completedAt: new Date(),
    completedTasks: completedCount,
    failedTasks: failedCount,
  }).where(eq(batchJobsTable.id, newJob.id));
}

function computeNextRun(schedule: typeof schedulesTable.$inferSelect): Date | null {
  const now = new Date();

  if (schedule.type === "once") {
    return null;
  }

  if (schedule.type === "interval" && schedule.intervalMinutes) {
    return new Date(now.getTime() + schedule.intervalMinutes * 60 * 1000);
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

  return null;
}

async function tick() {
  try {
    const now = new Date();
    const due = await db.select().from(schedulesTable)
      .where(and(
        eq(schedulesTable.enabled, true),
        lte(schedulesTable.nextRunAt, now)
      ));

    for (const schedule of due) {
      const [templateJob] = await db.select().from(batchJobsTable)
        .where(eq(batchJobsTable.id, schedule.jobId))
        .limit(1);

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

          const excelData = templateJob.excelData as Record<string, string>[] | undefined;
          const excelLookup = buildExcelLookup(excelData);
          let completedCount = 0;
          let failedCount = 0;

          for (let i = 0; i < routers.length; i++) {
            const r = routers[i];
            const [task] = await db.select().from(jobTasksTable)
              .where(and(eq(jobTasksTable.jobId, templateJob.id), eq(jobTasksTable.routerId, r.id)))
              .limit(1);
            if (!task) continue;

            await db.update(jobTasksTable).set({ status: "running", startedAt: new Date() }).where(eq(jobTasksTable.id, task.id));

            const row = findExcelRow(r, excelLookup, i, excelData);
            const finalScript = applyTagSubstitution(templateJob.scriptCode, row);
            await db.update(jobTasksTable).set({ resolvedScript: finalScript }).where(eq(jobTasksTable.id, task.id));

            if (!r.sshPassword) {
              failedCount++;
              await db.update(jobTasksTable).set({
                status: "failed", errorMessage: "No SSH password configured", completedAt: new Date(),
              }).where(eq(jobTasksTable.id, task.id));
              await db.update(batchJobsTable).set({ failedTasks: failedCount }).where(eq(batchJobsTable.id, templateJob.id));
              continue;
            }

            try {
              const result = await executeSSHCommand(r.ipAddress, r.sshPort ?? 22, r.sshUsername, r.sshPassword, finalScript, 30000, templateJob.autoConfirm);
              if (result.success) { completedCount++; await db.update(jobTasksTable).set({ status: "success", output: result.output, connectionLog: result.connectionLog, completedAt: new Date() }).where(eq(jobTasksTable.id, task.id)); }
              else { failedCount++; await db.update(jobTasksTable).set({ status: "failed", output: result.output, errorMessage: result.errorMessage, connectionLog: result.connectionLog, completedAt: new Date() }).where(eq(jobTasksTable.id, task.id)); }
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

let intervalHandle: ReturnType<typeof setInterval> | null = null;
let tickInFlight = false;

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
