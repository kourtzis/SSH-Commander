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

export const scheduleTypeEnum = pgEnum("schedule_type", [
  "once",
  "interval",
  "weekly",
]);

export const schedulesTable = pgTable("schedules", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  jobId: integer("job_id").notNull(),
  type: scheduleTypeEnum("type").notNull(),
  scheduledAt: timestamp("scheduled_at"),
  intervalMinutes: integer("interval_minutes"),
  daysOfWeek: json("days_of_week").$type<number[]>(),
  timeOfDay: text("time_of_day"),
  nextRunAt: timestamp("next_run_at"),
  lastRunAt: timestamp("last_run_at"),
  enabled: boolean("enabled").notNull().default(true),
  runCount: integer("run_count").notNull().default(0),
  createdBy: integer("created_by").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (table) => [
  index("idx_schedules_job_id").on(table.jobId),
  index("idx_schedules_next_run_at").on(table.nextRunAt),
  index("idx_schedules_enabled").on(table.enabled),
  index("idx_schedules_created_by").on(table.createdBy),
]);

export type Schedule = typeof schedulesTable.$inferSelect;
