import { pgTable, text, timestamp, jsonb } from "drizzle-orm/pg-core";

// Small key/value store for operator-tunable app configuration that doesn't
// deserve its own table. Known keys:
//   "backup_schedule"      → { enabled: boolean, timeOfDay: "HH:MM", retentionPerRouter: number }
//   "backup_last_run_date" → { date: "YYYY-MM-DD" }   (scheduler bookkeeping)
//   "audit_retention_days" → { days: number }
export const appSettingsTable = pgTable("app_settings", {
  key: text("key").primaryKey(),
  value: jsonb("value").$type<Record<string, unknown>>().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type AppSettingRow = typeof appSettingsTable.$inferSelect;
