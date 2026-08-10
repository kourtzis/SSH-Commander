import { pgTable, serial, text, integer, timestamp, pgEnum, boolean, index } from "drizzle-orm/pg-core";

export const channelTypeEnum = pgEnum("channel_type", ["telegram", "email", "webhook"]);

// Where alerts get delivered. `config` is a JSON string encrypted at rest
// with the shared AES-256-GCM helpers (lib/db/src/crypto.ts) because it
// carries live credentials: Telegram bot tokens, SMTP passwords, webhook
// signing secrets. It is decrypted only at send time and never returned
// to clients unredacted.
export const notificationChannelsTable = pgTable("notification_channels", {
  id: serial("id").primaryKey(),
  name: text("name").notNull().unique(),
  type: channelTypeEnum("type").notNull(),
  config: text("config").notNull(),           // encrypted JSON string, shape depends on type
  enabled: boolean("enabled").notNull().default(true),
  lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
  lastError: text("last_error"),              // most recent delivery failure, cleared on success
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// Which events fire which channels. Router/group scoping applies to
// device-centric events; empty arrays mean "all devices".
export const alertRulesTable = pgTable("alert_rules", {
  id: serial("id").primaryKey(),
  name: text("name").notNull().unique(),
  eventTypes: text("event_types").array().notNull(),
  routerIds: integer("router_ids").array().notNull().default([]),
  groupIds: integer("group_ids").array().notNull().default([]),
  channelIds: integer("channel_ids").array().notNull(),
  // Suppress repeat notifications of the same event+entity within this
  // window. A flapping WAN link would otherwise fire device_down/device_up
  // pairs every reachability tick.
  cooldownMinutes: integer("cooldown_minutes").notNull().default(5),
  enabled: boolean("enabled").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const alertEventStatusEnum = pgEnum("alert_event_status", ["sent", "failed", "suppressed"]);

// Delivery history. ruleId is an audit field (not a FK) so history survives
// rule deletion; ruleName is snapshotted for the same reason.
export const alertEventsTable = pgTable("alert_events", {
  id: serial("id").primaryKey(),
  ruleId: integer("rule_id"),
  ruleName: text("rule_name").notNull(),
  eventType: text("event_type").notNull(),
  subject: text("subject").notNull(),
  message: text("message").notNull(),
  status: alertEventStatusEnum("status").notNull(),
  error: text("error"),                        // aggregated per-channel failures
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("idx_alert_events_created_at").on(table.createdAt),
]);

export type NotificationChannelRow = typeof notificationChannelsTable.$inferSelect;
export type AlertRuleRow = typeof alertRulesTable.$inferSelect;
export type AlertEventRow = typeof alertEventsTable.$inferSelect;
