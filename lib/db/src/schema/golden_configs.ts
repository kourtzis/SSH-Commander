import { pgTable, serial, text, integer, timestamp, boolean, index, uniqueIndex } from "drizzle-orm/pg-core";
import { routerGroupsTable } from "./groups";

// The intended configuration baseline for every router in a group.
// One golden config per group (unique index) — drift is a group-level
// compliance concept, not a per-device one. Deleting the group deletes
// its baseline and (via cascade below) all drift results.
export const goldenConfigsTable = pgTable("golden_configs", {
  id: serial("id").primaryKey(),
  groupId: integer("group_id").notNull().references(() => routerGroupsTable.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  content: text("content").notNull(), // the baseline RouterOS export
  // Regex strings; matching lines are excluded from comparison on BOTH
  // sides. For volatile lines (clocks, auto-generated comments, serials)
  // that would otherwise flag every device as drifted.
  ignorePatterns: text("ignore_patterns").array().notNull().default([]),
  updatedBy: integer("updated_by"), // audit field, not a FK
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("uq_golden_configs_group_id").on(table.groupId),
]);

// Latest drift verdict per (golden config, router) — upserted on every
// check, so the table stays small: current state, not history. The full
// unified diff is stored only when drifted (NULL when in sync).
export const driftResultsTable = pgTable("drift_results", {
  id: serial("id").primaryKey(),
  goldenConfigId: integer("golden_config_id").notNull().references(() => goldenConfigsTable.id, { onDelete: "cascade" }),
  routerId: integer("router_id").notNull(),  // audit field, not a FK; name/IP snapshotted
  routerName: text("router_name").notNull(),
  routerIp: text("router_ip").notNull(),
  backupId: integer("backup_id"),            // which config_backups row was compared (informational)
  inSync: boolean("in_sync").notNull(),
  addedLines: integer("added_lines").notNull().default(0),   // on device, missing from golden
  removedLines: integer("removed_lines").notNull().default(0), // in golden, missing on device
  diff: text("diff"),
  checkedAt: timestamp("checked_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("uq_drift_results_golden_router").on(table.goldenConfigId, table.routerId),
  index("idx_drift_results_router_id").on(table.routerId),
]);

export type GoldenConfigRow = typeof goldenConfigsTable.$inferSelect;
export type DriftResultRow = typeof driftResultsTable.$inferSelect;
