import {
  pgTable,
  serial,
  text,
  integer,
  timestamp,
  json,
  pgEnum,
  boolean,
  index,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

// Job lifecycle: pending → running → completed/failed/cancelled
// "scheduled" is a special status for template jobs used by the scheduler
export const jobStatusEnum = pgEnum("job_status", [
  "pending",
  "running",
  "completed",
  "failed",
  "cancelled",
  "scheduled",
]);

// Per-router task lifecycle: pending → running → success/failed
// "waiting_input" is used in interactive mode when a prompt is detected
export const taskStatusEnum = pgEnum("task_status", [
  "pending",
  "running",
  "success",
  "failed",
  "waiting_input",
]);

// A batch job — runs a script across one or more routers.
// Stores the original targeting info (router IDs + group IDs) and Excel variable data.
// The job acts as both an execution record and, when status="scheduled", a reusable template.
export const batchJobsTable = pgTable("batch_jobs", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  scriptCode: text("script_code").notNull(),   // SSH commands to execute (may contain {{TAG}} variables)
  status: jobStatusEnum("status").notNull().default("pending"),
  targetRouterIds: json("target_router_ids").$type<number[]>().notNull().default([]),  // Directly selected routers
  targetGroupIds: json("target_group_ids").$type<number[]>().notNull().default([]),    // Selected groups (resolved at runtime)
  excelData: json("excel_data").$type<Record<string, string>[]>(),  // Per-router variable rows from CSV/Excel upload
  autoConfirm: boolean("auto_confirm").notNull().default(true),     // If false, prompts pause for user input (interactive mode)
  totalTasks: integer("total_tasks").notNull().default(0),
  completedTasks: integer("completed_tasks").notNull().default(0),  // Running counters updated as tasks finish
  failedTasks: integer("failed_tasks").notNull().default(0),
  createdBy: integer("created_by").notNull(),   // FK to users.id
  createdAt: timestamp("created_at").notNull().defaultNow(),
  completedAt: timestamp("completed_at"),       // Set when all tasks finish
}, (table) => [
  index("idx_batch_jobs_status").on(table.status),
  index("idx_batch_jobs_created_by").on(table.createdBy),
  index("idx_batch_jobs_created_at").on(table.createdAt),
]);

// One task per router within a batch job — tracks individual SSH execution results
export const jobTasksTable = pgTable("job_tasks", {
  id: serial("id").primaryKey(),
  jobId: integer("job_id").notNull(),           // FK to batch_jobs.id
  routerId: integer("router_id").notNull(),     // FK to routers.id
  routerName: text("router_name").notNull(),    // Snapshot at job creation time (so logs remain valid if router is renamed)
  routerIp: text("router_ip").notNull(),        // Snapshot of IP at creation time
  status: taskStatusEnum("status").notNull().default("pending"),
  output: text("output"),                       // Raw SSH session output
  errorMessage: text("error_message"),          // Error description if task failed
  connectionLog: text("connection_log"),        // Timestamped SSH handshake/connection log
  resolvedScript: text("resolved_script"),      // Script after {{TAG}} substitution
  promptText: text("prompt_text"),              // Current interactive prompt text (cleared on resume)
  startedAt: timestamp("started_at"),
  completedAt: timestamp("completed_at"),
}, (table) => [
  index("idx_job_tasks_job_id").on(table.jobId),
  index("idx_job_tasks_router_id").on(table.routerId),
  index("idx_job_tasks_status").on(table.status),
  index("idx_job_tasks_job_router").on(table.jobId, table.routerId), // Composite for fast task lookup by job+router
]);

export const insertJobSchema = createInsertSchema(batchJobsTable).omit({
  id: true,
  createdAt: true,
  completedAt: true,
  totalTasks: true,
  completedTasks: true,
  failedTasks: true,
  status: true,
});

export type InsertJob = z.infer<typeof insertJobSchema>;
export type BatchJob = typeof batchJobsTable.$inferSelect;
export type JobTask = typeof jobTasksTable.$inferSelect;
