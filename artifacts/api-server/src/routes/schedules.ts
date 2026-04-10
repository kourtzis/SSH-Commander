// ─── Schedule Routes ────────────────────────────────────────────────
// CRUD for job schedules. A schedule binds a template job (status="scheduled")
// to a recurrence pattern (once, interval, or weekly). The scheduler tick
// engine polls every 30 seconds and executes any schedule whose nextRunAt
// has passed.

import { Router, type IRouter } from "express";
import { db, schedulesTable, batchJobsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { requireAuth, getCurrentUser } from "../lib/auth.js";

const router: IRouter = Router();

// GET /schedules — List all schedules (ordered by creation time)
router.get("/schedules", async (req, res) => {
  requireAuth(req);
  const schedules = await db.select().from(schedulesTable).orderBy(schedulesTable.createdAt);
  res.json(schedules);
});

// GET /schedules/:id — Get a single schedule by ID
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

// POST /schedules — Create a new schedule.
// Validates the template job exists and has status="scheduled".
// Computes the initial nextRunAt based on the schedule type.
router.post("/schedules", async (req, res) => {
  requireAuth(req);
  const user = await getCurrentUser(req);
  const { name, jobId, type, scheduledAt, intervalMinutes, daysOfWeek, timeOfDay } = req.body;

  if (!name || !jobId || !type) {
    res.status(400).json({ error: "name, jobId, and type are required" });
    return;
  }

  // Verify the template job exists
  const [job] = await db.select().from(batchJobsTable).where(eq(batchJobsTable.id, jobId)).limit(1);
  if (!job) {
    res.status(404).json({ error: "Job not found" });
    return;
  }

  // Only "scheduled" status jobs can be used as templates
  if (job.status !== "scheduled") {
    res.status(400).json({ error: "Only jobs saved with 'Schedule' mode can be used as templates" });
    return;
  }

  // Compute the first run time based on schedule type
  let nextRunAt: Date | null = null;

  if (type === "once") {
    // One-time: run at the specified absolute time
    if (!scheduledAt) {
      res.status(400).json({ error: "scheduledAt is required for one-time schedules" });
      return;
    }
    nextRunAt = new Date(scheduledAt);
  } else if (type === "interval") {
    // Interval: first run is N minutes from now
    if (!intervalMinutes || intervalMinutes < 1) {
      res.status(400).json({ error: "intervalMinutes must be at least 1" });
      return;
    }
    nextRunAt = new Date(Date.now() + intervalMinutes * 60 * 1000);
  } else if (type === "weekly") {
    // Weekly: find the next matching day+time within 7 days
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
    // Fallback: same day next week
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

// PUT /schedules/:id — Update schedule name and/or enabled state
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

// DELETE /schedules/:id — Remove a schedule
router.delete("/schedules/:id", async (req, res) => {
  requireAuth(req);
  const id = parseInt(req.params.id);
  await db.delete(schedulesTable).where(eq(schedulesTable.id, id));
  res.json({ message: "Schedule deleted" });
});

export default router;
