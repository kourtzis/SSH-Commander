import { pgTable, serial, text, integer, timestamp, jsonb, index } from "drizzle-orm/pg-core";

// Fleet-wide audit trail: who did what to which resource, from where.
// Write-only from the app's perspective (no updates), pruned by a daily
// retention sweep (default 90 days, configurable via app_settings).
//
// userId is an audit field, not a FK — deleting a user must not erase the
// record of what they did; username is snapshotted for display.
export const auditLogTable = pgTable("audit_log", {
  id: serial("id").primaryKey(),
  userId: integer("user_id"),                 // NULL for system-initiated actions
  username: text("username").notNull(),       // snapshot ("system" for background actors)
  action: text("action").notNull(),           // dot-namespaced: "auth.login", "router.create", "job.run", ...
  resourceType: text("resource_type"),        // "router" | "job" | "user" | ...
  resourceId: text("resource_id"),
  resourceName: text("resource_name"),
  details: jsonb("details").$type<Record<string, unknown>>(),
  ip: text("ip"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("idx_audit_log_created_at").on(table.createdAt),
  index("idx_audit_log_user_id").on(table.userId),
  index("idx_audit_log_action").on(table.action),
]);

export type AuditLogRow = typeof auditLogTable.$inferSelect;
