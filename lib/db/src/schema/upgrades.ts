import { pgTable, serial, text, integer, timestamp, pgEnum, boolean, index } from "drizzle-orm/pg-core";

export const upgradeRunStatusEnum = pgEnum("upgrade_run_status", [
  "running",
  "completed",
  "failed",
  "cancelled",
]);

// Per-device pipeline. A task walks pending → (backing_up) → upgrading →
// rebooting → verifying → success/failed. "skipped" is set by cancellation
// (device untouched) or when the device reports no update available and the
// operator asked only for outdated devices — never mid-flight.
export const upgradeTaskStatusEnum = pgEnum("upgrade_task_status", [
  "pending",
  "backing_up",
  "upgrading",
  "rebooting",
  "verifying",
  "success",
  "failed",
  "skipped",
]);

// An upgrade orchestration run across one or more RouterOS devices.
// Deliberately separate from batch_jobs: an upgrade is a multi-phase state
// machine with reboots and reachability polling, not a single SSH script.
export const upgradeRunsTable = pgTable("upgrade_runs", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  status: upgradeRunStatusEnum("status").notNull().default("running"),
  preBackup: boolean("pre_backup").notNull().default(true), // snapshot config before touching each device
  totalTasks: integer("total_tasks").notNull().default(0),
  completedTasks: integer("completed_tasks").notNull().default(0), // success + skipped
  failedTasks: integer("failed_tasks").notNull().default(0),
  createdBy: integer("created_by"), // audit field, not a FK (jobs pattern)
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
}, (table) => [
  index("idx_upgrade_runs_status").on(table.status),
  index("idx_upgrade_runs_created_at").on(table.createdAt),
]);

export const upgradeTasksTable = pgTable("upgrade_tasks", {
  id: serial("id").primaryKey(),
  runId: integer("run_id").notNull().references(() => upgradeRunsTable.id, { onDelete: "cascade" }),
  // Audit field — not a FK; name/IP snapshotted so history survives router deletion.
  routerId: integer("router_id").notNull(),
  routerName: text("router_name").notNull(),
  routerIp: text("router_ip").notNull(),
  status: upgradeTaskStatusEnum("status").notNull().default("pending"),
  oldVersion: text("old_version"),   // fingerprinted RouterOS version before install
  newVersion: text("new_version"),   // re-fingerprinted version after reboot
  log: text("log").notNull().default(""), // appended human-readable progress lines
  errorMessage: text("error_message"),
  startedAt: timestamp("started_at", { withTimezone: true }),
  completedAt: timestamp("completed_at", { withTimezone: true }),
}, (table) => [
  index("idx_upgrade_tasks_run_id").on(table.runId),
]);

export type UpgradeRunRow = typeof upgradeRunsTable.$inferSelect;
export type UpgradeTaskRow = typeof upgradeTasksTable.$inferSelect;
