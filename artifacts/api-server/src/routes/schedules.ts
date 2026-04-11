import { Router, type IRouter } from "express";
import { db, schedulesTable, batchJobsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { requireAuth, getCurrentUser } from "../lib/auth.js";

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
  requireAuth(req);
  const user = await getCurrentUser(req);
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
  requireAuth(req);
  const id = parseInt(req.params.id);
  const { name, enabled } = req.body;

  const updates: Record<string, any> = {};
  if (name !== undefined) updates.name = name;
  if (enabled !== undefined) updates.enabled = enabled;

  const [updated] = await db.update(schedulesTable).set(updates).where(eq(schedulesTable.id, id)).returning();
  if (!updated) {
    res.status(404).json({ error: "Schedule not found" });
    return;
  }
  res.json(updated);
});

router.delete("/schedules/:id", async (req, res) => {
  requireAuth(req);
  const id = parseInt(req.params.id);
  await db.delete(schedulesTable).where(eq(schedulesTable.id, id));
  res.json({ message: "Schedule deleted" });
});

export default router;
export { computeNextWeeklyRun, computeNextDailyRun, computeNextMonthlyRun };
