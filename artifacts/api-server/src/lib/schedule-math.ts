// ─── Schedule date math (pure) ──────────────────────────────────────
// Extracted from scheduler.ts so the next-run computation can be unit
// tested without importing the DB-coupled scheduler module (which opens
// a pg Pool at import time and would require a live DATABASE_URL).
//
// Everything here is pure: given a schedule row + the current time it
// returns the next Date the schedule should fire, or null for "once"
// schedules (which never repeat). The only dependency on @workspace/db
// is a TYPE import for the schedule row shape, which is erased at compile
// time and creates no runtime coupling.

import type { schedulesTable } from "@workspace/db";

export type ScheduleRow = typeof schedulesTable.$inferSelect;

// Nth weekday of a month (e.g. "3rd Tuesday"). Returns null if that
// occurrence doesn't exist in the given month (e.g. a 5th Friday).
export function getNthWeekdayOfMonth(
  year: number,
  month: number,
  nth: number,
  weekday: number,
): Date | null {
  const firstDay = new Date(year, month, 1);
  let firstOccurrence = firstDay.getDate() + ((weekday - firstDay.getDay() + 7) % 7);
  const target = firstOccurrence + (nth - 1) * 7;
  const lastDay = new Date(year, month + 1, 0).getDate();
  if (target > lastDay) return null;
  return new Date(year, month, target);
}

// Compute the next fire time for a schedule relative to `now` (defaults
// to the current time; injectable for testing). Returns null for "once"
// schedules and for malformed rows that don't match any branch.
export function computeNextRun(
  schedule: ScheduleRow,
  now: Date = new Date(),
): Date | null {
  if (schedule.type === "once") {
    return null;
  }

  if (schedule.type === "interval" && schedule.intervalMinutes) {
    // Drift-resistant scheduling: anchor the next run on the previous
    // nextRunAt rather than now(). Otherwise every late tick (scheduler
    // backed up by a long-running job, container restart, etc.) silently
    // shifts the entire cadence forward — a "every 60 min" schedule that
    // misses by 7 minutes becomes "every 67 min from then on". Walk the
    // anchor forward by N intervals until it lands in the future, so we
    // skip any missed slots cleanly without compounding drift.
    const intervalMs = schedule.intervalMinutes * 60 * 1000;
    const anchor = schedule.nextRunAt ? new Date(schedule.nextRunAt).getTime() : now.getTime();
    let next = anchor + intervalMs;
    if (next <= now.getTime()) {
      const missed = Math.ceil((now.getTime() - next) / intervalMs);
      next += missed * intervalMs;
    }
    return new Date(next);
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
