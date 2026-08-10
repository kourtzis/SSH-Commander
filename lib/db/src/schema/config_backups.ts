import { pgTable, serial, text, integer, timestamp, pgEnum, index } from "drizzle-orm/pg-core";

// How a backup came to exist. pre_upgrade snapshots are taken automatically
// by the upgrade orchestrator right before touching a device.
export const backupKindEnum = pgEnum("backup_kind", ["manual", "scheduled", "pre_upgrade"]);
export const backupStatusEnum = pgEnum("backup_status", ["success", "failed"]);

// One captured `/export` of a device's RouterOS configuration.
//
// Dedup: before inserting, the runner compares the normalized content hash
// against the router's most recent successful backup. If identical, no new
// row is written — instead lastSeenAt on the existing row is bumped, so a
// row reads as "this exact config was in effect from createdAt until at
// least lastSeenAt". This keeps nightly scheduled backups from producing
// hundreds of identical copies.
export const configBackupsTable = pgTable("config_backups", {
  id: serial("id").primaryKey(),
  // Audit field — intentionally NOT a FK (jobs pattern): deleting a router
  // must not erase its config history. Name/IP are snapshotted below.
  routerId: integer("router_id").notNull(),
  routerName: text("router_name").notNull(),
  routerIp: text("router_ip").notNull(),
  kind: backupKindEnum("kind").notNull().default("manual"),
  status: backupStatusEnum("status").notNull().default("success"),
  content: text("content").notNull().default(""),        // full /export output ("" for failed attempts)
  contentHash: text("content_hash").notNull().default(""), // sha256 of normalized content
  sizeBytes: integer("size_bytes").notNull().default(0),
  errorMessage: text("error_message"),                   // populated when status=failed
  createdBy: integer("created_by"),                      // user id; NULL = scheduler/system
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }), // dedup marker (see above)
}, (table) => [
  index("idx_config_backups_router_id").on(table.routerId),
  index("idx_config_backups_created_at").on(table.createdAt),
  index("idx_config_backups_router_created").on(table.routerId, table.createdAt),
]);

export type ConfigBackupRow = typeof configBackupsTable.$inferSelect;
