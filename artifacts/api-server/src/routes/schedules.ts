import { Router, type IRouter } from "express";
import { db, schedulesTable, batchJobsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { requireAuth, requireAdminAuth, getCurrentUser } from "../lib/auth.js";

const router: IRouter = Router();

router.get("/schedules", async (req, res) => {
  requireAuth(req);
  const schedules = await db.select().from(schedulesTable).orderBy(schedulesTable.createdAt);
  res.json(schedules);
});

router.get("/schedules/:id", async (req, res) => {
  requireAuth(req);
  const id = parseInt(req.params.id);
  const [schedule] = await db.select().from(schedulesTable).where(eq(schedulesTable.id, id)).limit(1);
  if (!schedule) {
    res.status(404).json({ error: "Schedule not found" });
    return;
  }
  res.json(schedule);
});

function computeNextWeeklyRun(daysOfWeek: number[], timeOfDay: string): Date {
  const [hours, minutes] = timeOfDay.split(":").map(Number);
  const now = new Date();
  for (let offset = 0; offset <= 7; offset++) {
    const candidate = new Date(now);
    candidate.setDate(candidate.getDate() + offset);
    candidate.setHours(hours, minutes, 0, 0);
    if (candidate > now && daysOfWeek.includes(candidate.getDay())) {
      return candidate;
    }
  }
  const fallback = new Date(now);
  fallback.setDate(fallback.getDate() + 7);
  fallback.setHours(hours, minutes, 0, 0);
  return fallback;
}

function computeNextDailyRun(timeOfDay: string): Date {
  const [hours, minutes] = timeOfDay.split(":").map(Number);
  const now = new Date();
  const today = new Date(now);
  today.setHours(hours, minutes, 0, 0);
  if (today > now) return today;
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  tomorrow.setHours(hours, minutes, 0, 0);
  return tomorrow;
}

function computeNextMonthlyRun(
  monthlyMode: string,
  dayOfMonth?: number | null,
  nthWeek?: number | null,
  nthWeekday?: number | null,
  timeOfDay?: string | null,
): Date {
  const [hours, minutes] = (timeOfDay ?? "00:00").split(":").map(Number);
  const now = new Date();

  if (monthlyMode === "dayOfMonth" && dayOfMonth) {
    for (let monthOffset = 0; monthOffset <= 12; monthOffset++) {
      const candidate = new Date(now.getFullYear(), now.getMonth() + monthOffset, 1);
      const lastDay = new Date(candidate.getFullYear(), candidate.getMonth() + 1, 0).getDate();
      const day = Math.min(dayOfMonth, lastDay);
      candidate.setDate(day);
      candidate.setHours(hours, minutes, 0, 0);
      if (candidate > now) return candidate;
    }
  }

  if (monthlyMode === "nthWeekday" && nthWeek && nthWeekday !== null && nthWeekday !== undefined) {
    for (let monthOffset = 0; monthOffset <= 12; monthOffset++) {
      const candidate = getNthWeekdayOfMonth(
        now.getFullYear(),
        now.getMonth() + monthOffset,
        nthWeek,
        nthWeekday,
      );
      if (candidate) {
        candidate.setHours(hours, minutes, 0, 0);
        if (candidate > now) return candidate;
      }
    }
  }

  const fallback = new Date(now);
  fallback.setMonth(fallback.getMonth() + 1);
  fallback.setHours(hours, minutes, 0, 0);
  return fallback;
}

function getNthWeekdayOfMonth(year: number, month: number, nth: number, weekday: number): Date | null {
  const firstDay = new Date(year, month, 1);
  let firstOccurrence = firstDay.getDate() + ((weekday - firstDay.getDay() + 7) % 7);
  const target = firstOccurrence + (nth - 1) * 7;
  const lastDay = new Date(year, month + 1, 0).getDate();
  if (target > lastDay) return null;
  return new Date(year, month, target);
}

router.post("/schedules", async (req, res) => {
  const user = await requireAdminAuth(req);
  const { name, jobId, type, scheduledAt, intervalMinutes, daysOfWeek, timeOfDay, dayOfMonth, monthlyMode, nthWeek, nthWeekday } = req.body;

  if (!name || !jobId || !type) {
    res.status(400).json({ error: "name, jobId, and type are required" });
    return;
  }

  const [job] = await db.select().from(batchJobsTable).where(eq(batchJobsTable.id, jobId)).limit(1);
  if (!job) {
    res.status(404).json({ error: "Job not found" });
    return;
  }

  if (job.status !== "scheduled") {
    res.status(400).json({ error: "Only jobs saved with 'Schedule' mode can be used as templates" });
    return;
  }

  let nextRunAt: Date | null = null;

  if (type === "once") {
    if (!scheduledAt) {
      res.status(400).json({ error: "scheduledAt is required for one-time schedules" });
      return;
    }
    nextRunAt = new Date(scheduledAt);
  } else if (type === "interval") {
    if (!intervalMinutes || intervalMinutes < 1) {
      res.status(400).json({ error: "intervalMinutes must be at least 1" });
      return;
    }
    nextRunAt = new Date(Date.now() + intervalMinutes * 60 * 1000);
  } else if (type === "daily") {
    if (!timeOfDay) {
      res.status(400).json({ error: "timeOfDay is required for daily schedules" });
      return;
    }
    nextRunAt = computeNextDailyRun(timeOfDay);
  } else if (type === "weekly") {
    if (!daysOfWeek || !Array.isArray(daysOfWeek) || daysOfWeek.length === 0 || !timeOfDay) {
      res.status(400).json({ error: "daysOfWeek and timeOfDay are required for weekly schedules" });
      return;
    }
    nextRunAt = computeNextWeeklyRun(daysOfWeek, timeOfDay);
  } else if (type === "monthly") {
    if (!monthlyMode || !timeOfDay) {
      res.status(400).json({ error: "monthlyMode and timeOfDay are required for monthly schedules" });
      return;
    }
    if (monthlyMode === "dayOfMonth" && !dayOfMonth) {
      res.status(400).json({ error: "dayOfMonth is required for day-of-month mode" });
      return;
    }
    if (monthlyMode === "nthWeekday" && (nthWeek == null || nthWeekday == null)) {
      res.status(400).json({ error: "nthWeek and nthWeekday are required for nth-weekday mode" });
      return;
    }
    nextRunAt = computeNextMonthlyRun(monthlyMode, dayOfMonth, nthWeek, nthWeekday, timeOfDay);
  }

  const [schedule] = await db.insert(schedulesTable).values({
    name,
    jobId,
    type,
    scheduledAt: scheduledAt ? new Date(scheduledAt) : null,
    intervalMinutes: intervalMinutes || null,
    daysOfWeek: daysOfWeek || null,
    timeOfDay: timeOfDay || null,
    dayOfMonth: dayOfMonth || null,
    monthlyMode: monthlyMode || null,
    nthWeek: nthWeek ?? null,
    nthWeekday: nthWeekday ?? null,
    nextRunAt,
    enabled: true,
    runCount: 0,
    createdBy: user!.id,
  }).returning();

  res.status(201).json(schedule);
});

router.put("/schedules/:id", async (req, res) => {
  await requireAdminAuth(req);
  const id = parseInt(req.params.id);
  const {
    name,
    enabled,
    jobId,
    type,
    scheduledAt,
    intervalMinutes,
    daysOfWeek,
    timeOfDay,
    dayOfMonth,
    monthlyMode,
    nthWeek,
    nthWeekday,
  } = req.body ?? {};

  // Load existing so we can validate and recompute nextRunAt with merged fields
  const [existing] = await db
    .select()
    .from(schedulesTable)
    .where(eq(schedulesTable.id, id))
    .limit(1);
  if (!existing) {
    res.status(404).json({ error: "Schedule not found" });
    return;
  }

  // If a new job is provided, ensure it exists and is a scheduled-template job
  if (jobId !== undefined && jobId !== existing.jobId) {
    const [job] = await db.select().from(batchJobsTable).where(eq(batchJobsTable.id, jobId)).limit(1);
    if (!job) {
      res.status(404).json({ error: "Job not found" });
      return;
    }
    if (job.status !== "scheduled") {
      res.status(400).json({ error: "Only jobs saved with 'Schedule' mode can be used as templates" });
      return;
    }
  }

  const updates: Record<string, any> = {};
  if (name !== undefined) updates.name = name;
  if (enabled !== undefined) updates.enabled = enabled;
  if (jobId !== undefined) updates.jobId = jobId;

  // Merged values used for nextRunAt recomputation
  const mergedType = type ?? existing.type;
  const mergedTimeOfDay = timeOfDay ?? existing.timeOfDay;
  const mergedInterval = intervalMinutes ?? existing.intervalMinutes;
  const mergedDays = daysOfWeek ?? existing.daysOfWeek;
  const mergedDayOfMonth = dayOfMonth ?? existing.dayOfMonth;
  const mergedMonthlyMode = monthlyMode ?? existing.monthlyMode;
  const mergedNthWeek = nthWeek ?? existing.nthWeek;
  const mergedNthWeekday = nthWeekday ?? existing.nthWeekday;
  const mergedScheduledAt = scheduledAt !== undefined ? scheduledAt : existing.scheduledAt;

  // Whether timing-related fields changed (need to recompute nextRunAt)
  const timingChanged =
    type !== undefined ||
    scheduledAt !== undefined ||
    intervalMinutes !== undefined ||
    daysOfWeek !== undefined ||
    timeOfDay !== undefined ||
    dayOfMonth !== undefined ||
    monthlyMode !== undefined ||
    nthWeek !== undefined ||
    nthWeekday !== undefined;

  if (type !== undefined) updates.type = type;
  if (scheduledAt !== undefined) updates.scheduledAt = scheduledAt ? new Date(scheduledAt) : null;
  if (intervalMinutes !== undefined) updates.intervalMinutes = intervalMinutes;
  if (daysOfWeek !== undefined) updates.daysOfWeek = daysOfWeek;
  if (timeOfDay !== undefined) updates.timeOfDay = timeOfDay;
  if (dayOfMonth !== undefined) updates.dayOfMonth = dayOfMonth;
  if (monthlyMode !== undefined) updates.monthlyMode = monthlyMode;
  if (nthWeek !== undefined) updates.nthWeek = nthWeek;
  if (nthWeekday !== undefined) updates.nthWeekday = nthWeekday;

  if (timingChanged) {
    // Validate per-type required fields and recompute nextRunAt
    let nextRunAt: Date | null = null;
    if (mergedType === "once") {
      if (!mergedScheduledAt) {
        res.status(400).json({ error: "scheduledAt is required for one-time schedules" });
        return;
      }
      nextRunAt = new Date(mergedScheduledAt);
    } else if (mergedType === "interval") {
      if (!mergedInterval || mergedInterval < 1) {
        res.status(400).json({ error: "intervalMinutes must be at least 1" });
        return;
      }
      nextRunAt = new Date(Date.now() + mergedInterval * 60 * 1000);
    } else if (mergedType === "daily") {
      if (!mergedTimeOfDay) {
        res.status(400).json({ error: "timeOfDay is required for daily schedules" });
        return;
      }
      nextRunAt = computeNextDailyRun(mergedTimeOfDay);
    } else if (mergedType === "weekly") {
      if (!mergedDays || !Array.isArray(mergedDays) || mergedDays.length === 0 || !mergedTimeOfDay) {
        res.status(400).json({ error: "daysOfWeek and timeOfDay are required for weekly schedules" });
        return;
      }
      nextRunAt = computeNextWeeklyRun(mergedDays, mergedTimeOfDay);
    } else if (mergedType === "monthly") {
      if (!mergedMonthlyMode || !mergedTimeOfDay) {
        res.status(400).json({ error: "monthlyMode and timeOfDay are required for monthly schedules" });
        return;
      }
      if (mergedMonthlyMode === "dayOfMonth" && !mergedDayOfMonth) {
        res.status(400).json({ error: "dayOfMonth is required for day-of-month mode" });
        return;
      }
      if (mergedMonthlyMode === "nthWeekday" && (mergedNthWeek == null || mergedNthWeekday == null)) {
        res.status(400).json({ error: "nthWeek and nthWeekday are required for nth-weekday mode" });
        return;
      }
      nextRunAt = computeNextMonthlyRun(
        mergedMonthlyMode,
        mergedDayOfMonth,
        mergedNthWeek,
        mergedNthWeekday,
        mergedTimeOfDay,
      );
    }
    updates.nextRunAt = nextRunAt;
  }

  const [updated] = await db.update(schedulesTable).set(updates).where(eq(schedulesTable.id, id)).returning();
  res.json(updated);
});

router.delete("/schedules/:id", async (req, res) => {
  await requireAdminAuth(req);
  const id = parseInt(req.params.id);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid schedule id" }); return; }
  await db.delete(schedulesTable).where(eq(schedulesTable.id, id));
  res.json({ message: "Schedule deleted" });
});

// ─── Calendar view ───────────────────────────────────────────────────
// Returns every projected schedule run in the requested year+month.
// We intentionally don't reuse computeNextRun (which only returns a single
// "next" run from `now`) — instead we walk every day in the month and check
// whether each enabled schedule fires that day. Cap at 64 occurrences per
// schedule per month to bound output for high-frequency interval schedules.
router.get("/schedules/calendar", async (req, res) => {
  requireAuth(req);
  const year = parseInt(String(req.query.year || ""));
  const month = parseInt(String(req.query.month || "")); // 1-12
  if (!year || !month || month < 1 || month > 12) {
    res.status(400).json({ error: "year and month (1-12) are required" });
    return;
  }
  const monthStart = new Date(year, month - 1, 1, 0, 0, 0, 0);
  const monthEnd = new Date(year, month, 1, 0, 0, 0, 0); // exclusive

  const schedules = await db.select().from(schedulesTable).where(eq(schedulesTable.enabled, true));
  const jobs = await db.select({ id: batchJobsTable.id, name: batchJobsTable.name }).from(batchJobsTable);
  const jobMap = new Map(jobs.map((j) => [j.id, j.name]));

  type Entry = { scheduleId: number; scheduleName: string; jobName: string; datetime: string };
  const entries: Entry[] = [];

  for (const s of schedules) {
    const jobName = jobMap.get(s.jobId) ?? `Job #${s.jobId}`;
    const push = (d: Date) => {
      if (d >= monthStart && d < monthEnd) {
        entries.push({
          scheduleId: s.id,
          scheduleName: s.name,
          jobName,
          datetime: d.toISOString(),
        });
      }
    };

    if (s.type === "once" && s.scheduledAt) {
      push(new Date(s.scheduledAt));
      continue;
    }

    if (s.type === "interval" && s.intervalMinutes) {
      // Walk forward from the schedule's nextRunAt (or monthStart) in step increments.
      let cursor = s.nextRunAt ? new Date(s.nextRunAt) : new Date(monthStart);
      // Fast-forward up to monthStart so we don't loop millions of times for short intervals
      // when the schedule was created long ago.
      if (cursor < monthStart) {
        const stepMs = s.intervalMinutes * 60 * 1000;
        const skip = Math.floor((monthStart.getTime() - cursor.getTime()) / stepMs);
        cursor = new Date(cursor.getTime() + skip * stepMs);
      }
      let n = 0;
      while (cursor < monthEnd && n < 1024) {
        if (cursor >= monthStart) push(cursor);
        cursor = new Date(cursor.getTime() + s.intervalMinutes * 60 * 1000);
        n++;
      }
      continue;
    }

    if ((s.type === "daily" || s.type === "weekly" || s.type === "monthly") && s.timeOfDay) {
      const [hh, mm] = s.timeOfDay.split(":").map(Number);
      // Walk every day in the month and decide if the schedule fires that day
      const lastDay = new Date(year, month, 0).getDate();
      for (let day = 1; day <= lastDay; day++) {
        const d = new Date(year, month - 1, day, hh || 0, mm || 0, 0, 0);
        if (s.type === "daily") { push(d); continue; }
        if (s.type === "weekly") {
          const days = (s.daysOfWeek as number[] | null) ?? [];
          if (days.includes(d.getDay())) push(d);
          continue;
        }
        if (s.type === "monthly") {
          if (s.monthlyMode === "dayOfMonth" && s.dayOfMonth) {
            // Clamp to last day for short months (e.g. day 31 → Feb 28/29)
            const target = Math.min(s.dayOfMonth, lastDay);
            if (day === target) push(d);
          }
          if (s.monthlyMode === "nthWeekday" && s.nthWeek != null && s.nthWeekday != null) {
            // Find which occurrence of this weekday it is in the month
            if (d.getDay() === s.nthWeekday) {
              const occurrence = Math.floor((day - 1) / 7) + 1;
              const isLast = day + 7 > lastDay;
              if (s.nthWeek === occurrence || (s.nthWeek === 5 && isLast)) push(d);
            }
          }
        }
      }
    }
  }

  entries.sort((a, b) => a.datetime.localeCompare(b.datetime));
  res.json(entries);
});

export default router;
export { computeNextWeeklyRun, computeNextDailyRun, computeNextMonthlyRun };
