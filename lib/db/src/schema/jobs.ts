import {
  pgTable,
  serial,
  text,
  integer,
  timestamp,
  json,
  pgEnum,
  boolean,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const jobStatusEnum = pgEnum("job_status", [
  "pending",
  "running",
  "completed",
  "failed",
  "cancelled",
  "scheduled",
]);

export const taskStatusEnum = pgEnum("task_status", [
  "pending",
  "running",
  "success",
  "failed",
  "waiting_input",
]);

export const batchJobsTable = pgTable("batch_jobs", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  scriptCode: text("script_code").notNull(),
  status: jobStatusEnum("status").notNull().default("pending"),
  targetRouterIds: json("target_router_ids").$type<number[]>().notNull().default([]),
  targetGroupIds: json("target_group_ids").$type<number[]>().notNull().default([]),
  excelData: json("excel_data").$type<Record<string, string>[]>(),
  autoConfirm: boolean("auto_confirm").notNull().default(true),
  totalTasks: integer("total_tasks").notNull().default(0),
  completedTasks: integer("completed_tasks").notNull().default(0),
  failedTasks: integer("failed_tasks").notNull().default(0),
  createdBy: integer("created_by").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  completedAt: timestamp("completed_at"),
});

export const jobTasksTable = pgTable("job_tasks", {
  id: serial("id").primaryKey(),
  jobId: integer("job_id").notNull(),
  routerId: integer("router_id").notNull(),
  routerName: text("router_name").notNull(),
  routerIp: text("router_ip").notNull(),
  status: taskStatusEnum("status").notNull().default("pending"),
  output: text("output"),
  errorMessage: text("error_message"),
  connectionLog: text("connection_log"),
  resolvedScript: text("resolved_script"),
  promptText: text("prompt_text"),
  startedAt: timestamp("started_at"),
  completedAt: timestamp("completed_at"),
});

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
