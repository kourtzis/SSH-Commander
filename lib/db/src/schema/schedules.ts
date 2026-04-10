import {
  pgTable,
  serial,
  text,
  integer,
  timestamp,
  boolean,
  json,
  pgEnum,
  index,
} from "drizzle-orm/pg-core";

// Schedule types: "once" runs at a specific time then disables,
// "interval" repeats every N minutes, "weekly" runs on selected days/times
export const scheduleTypeEnum = pgEnum("schedule_type", [
  "once",
  "interval",
  "weekly",
]);

// A schedule binds a template job (status="scheduled") to a recurrence pattern.
// The scheduler tick engine polls for rows where nextRunAt <= now and enabled = true.
export const schedulesTable = pgTable("schedules", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  jobId: integer("job_id").notNull(),           // FK to batch_jobs.id (must be a "scheduled" status template)
  type: scheduleTypeEnum("type").notNull(),     // Recurrence pattern type
  scheduledAt: timestamp("scheduled_at"),       // Absolute run time (for "once" type)
  intervalMinutes: integer("interval_minutes"), // Repeat interval (for "interval" type)
  daysOfWeek: json("days_of_week").$type<number[]>(),  // 0=Sun..6=Sat (for "weekly" type)
  timeOfDay: text("time_of_day"),               // "HH:MM" string (for "weekly" type)
  nextRunAt: timestamp("next_run_at"),          // Computed next execution time — polled by scheduler
  lastRunAt: timestamp("last_run_at"),          // Tracks most recent execution
  enabled: boolean("enabled").notNull().default(true),  // Disabled after one-time runs or if template is missing
  runCount: integer("run_count").notNull().default(0),  // Total number of times this schedule has fired
  createdBy: integer("created_by").notNull(),   // FK to users.id
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (table) => [
  index("idx_schedules_job_id").on(table.jobId),
  index("idx_schedules_next_run_at").on(table.nextRunAt),  // Primary index for scheduler polling
  index("idx_schedules_enabled").on(table.enabled),
  index("idx_schedules_created_by").on(table.createdBy),
]);

export type Schedule = typeof schedulesTable.$inferSelect;
