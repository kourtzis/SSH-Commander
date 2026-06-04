import { describe, it, expect } from "vitest";
import { computeNextRun, getNthWeekdayOfMonth, type ScheduleRow } from "../src/lib/schedule-math.js";

// Build a schedule row with only the fields computeNextRun reads. The rest
// of the row shape is irrelevant to the date math, so we cast a partial.
function schedule(partial: Partial<ScheduleRow>): ScheduleRow {
  return partial as ScheduleRow;
}

describe("computeNextRun", () => {
  it("returns null for one-time schedules", () => {
    expect(computeNextRun(schedule({ type: "once" }), new Date())).toBeNull();
  });

  it("advances an interval schedule by exactly one interval when on time", () => {
    const now = new Date("2026-06-04T12:00:00.000Z");
    const next = computeNextRun(
      schedule({ type: "interval", intervalMinutes: 60, nextRunAt: now }),
      now,
    );
    // Anchored on nextRunAt + 60min, which is still in the future relative to now.
    expect(next?.toISOString()).toBe("2026-06-04T13:00:00.000Z");
  });

  it("skips missed interval slots without compounding drift", () => {
    // nextRunAt was 3h15m ago; interval is 60min. We should land on the next
    // whole-interval boundary in the future, not now()+60min.
    const now = new Date("2026-06-04T12:00:00.000Z");
    const anchor = new Date("2026-06-04T08:45:00.000Z");
    const next = computeNextRun(
      schedule({ type: "interval", intervalMinutes: 60, nextRunAt: anchor }),
      now,
    );
    // Boundaries: 09:45, 10:45, 11:45, 12:45 → first one strictly after 12:00.
    expect(next?.toISOString()).toBe("2026-06-04T12:45:00.000Z");
  });

  it("rolls a daily schedule to tomorrow once today's time has passed", () => {
    const now = new Date(2026, 5, 4, 14, 0, 0); // local 14:00
    const next = computeNextRun(schedule({ type: "daily", timeOfDay: "09:00" }), now);
    expect(next?.getDate()).toBe(5);
    expect(next?.getHours()).toBe(9);
    expect(next?.getMinutes()).toBe(0);
  });

  it("finds the next matching weekday for a weekly schedule", () => {
    // 2026-06-04 is a Thursday (getDay() === 4). A Mon/Wed (1,3) schedule
    // at 08:00 should next fire on Monday 2026-06-08.
    const now = new Date(2026, 5, 4, 10, 0, 0);
    const next = computeNextRun(
      schedule({ type: "weekly", daysOfWeek: [1, 3], timeOfDay: "08:00" }),
      now,
    );
    expect(next?.getDay()).toBe(1);
    expect(next?.getDate()).toBe(8);
    expect(next?.getHours()).toBe(8);
  });

  it("clamps a monthly dayOfMonth schedule to the last day of short months", () => {
    // Asking for the 31st in a 30-day window must clamp, not overflow into
    // the next month. From mid-June (30 days), day 31 → June 30.
    const now = new Date(2026, 5, 4, 10, 0, 0);
    const next = computeNextRun(
      schedule({ type: "monthly", monthlyMode: "dayOfMonth", dayOfMonth: 31, timeOfDay: "06:00" }),
      now,
    );
    expect(next?.getMonth()).toBe(5); // still June
    expect(next?.getDate()).toBe(30); // clamped to last day
    expect(next?.getHours()).toBe(6);
  });

  it("computes the nth-weekday monthly schedule and rolls to next month when passed", () => {
    // 2nd Tuesday of June 2026 is the 9th. If now is already past it, the
    // schedule should roll to the 2nd Tuesday of July (the 14th).
    const now = new Date(2026, 5, 20, 10, 0, 0);
    const next = computeNextRun(
      schedule({ type: "monthly", monthlyMode: "nthWeekday", nthWeek: 2, nthWeekday: 2, timeOfDay: "07:30" }),
      now,
    );
    expect(next?.getMonth()).toBe(6); // July
    expect(next?.getDay()).toBe(2); // Tuesday
    expect(next?.getDate()).toBe(14);
  });
});

describe("getNthWeekdayOfMonth", () => {
  it("finds the nth weekday when it exists", () => {
    // June 2026: the 1st is a Monday. The 2nd Tuesday is June 9.
    const d = getNthWeekdayOfMonth(2026, 5, 2, 2); // month index 5 = June, weekday 2 = Tue
    expect(d?.getDate()).toBe(9);
  });

  it("returns null when the occurrence does not exist (e.g. 5th Friday)", () => {
    // June 2026 has only four Fridays.
    const d = getNthWeekdayOfMonth(2026, 5, 5, 5);
    expect(d).toBeNull();
  });
});
