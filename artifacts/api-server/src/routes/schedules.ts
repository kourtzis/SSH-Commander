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

router.post("/schedules", async (req, res) => {
  requireAuth(req);
  const user = await getCurrentUser(req);
  const { name, jobId, type, scheduledAt, intervalMinutes, daysOfWeek, timeOfDay } = req.body;

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
  } else if (type === "weekly") {
    if (!daysOfWeek || !Array.isArray(daysOfWeek) || daysOfWeek.length === 0 || !timeOfDay) {
      res.status(400).json({ error: "daysOfWeek and timeOfDay are required for weekly schedules" });
      return;
    }
    const [hours, minutes] = timeOfDay.split(":").map(Number);
    const now = new Date();
    for (let offset = 0; offset <= 7; offset++) {
      const candidate = new Date(now);
      candidate.setDate(candidate.getDate() + offset);
      candidate.setHours(hours, minutes, 0, 0);
      if (candidate > now && daysOfWeek.includes(candidate.getDay())) {
        nextRunAt = candidate;
        break;
      }
    }
    if (!nextRunAt) {
      const candidate = new Date(now);
      candidate.setDate(candidate.getDate() + 7);
      candidate.setHours(hours, minutes, 0, 0);
      nextRunAt = candidate;
    }
  }

  const [schedule] = await db.insert(schedulesTable).values({
    name,
    jobId,
    type,
    scheduledAt: scheduledAt ? new Date(scheduledAt) : null,
    intervalMinutes: intervalMinutes || null,
    daysOfWeek: daysOfWeek || null,
    timeOfDay: timeOfDay || null,
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
