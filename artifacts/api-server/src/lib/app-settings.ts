// ─── App settings helpers ───────────────────────────────────────────
// Thin typed accessors over the app_settings key/value table. Callers
// always pass a fallback so a missing row never surfaces as undefined.

import { db, appSettingsTable } from "@workspace/db";
import { eq } from "drizzle-orm";

export async function getSetting<T extends Record<string, unknown>>(key: string, fallback: T): Promise<T> {
  const [row] = await db.select().from(appSettingsTable).where(eq(appSettingsTable.key, key)).limit(1);
  if (!row) return fallback;
  // Merge over the fallback so newly-introduced fields get their defaults
  // even when the stored value predates them.
  return { ...fallback, ...(row.value as Partial<T>) };
}

export async function setSetting(key: string, value: Record<string, unknown>): Promise<void> {
  await db
    .insert(appSettingsTable)
    .values({ key, value, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: appSettingsTable.key,
      set: { value, updatedAt: new Date() },
    });
}

// ─── Known settings ─────────────────────────────────────────────────
export interface BackupScheduleSettings extends Record<string, unknown> {
  enabled: boolean;
  timeOfDay: string; // "HH:MM" server-local
  retentionPerRouter: number;
}

export const BACKUP_SCHEDULE_KEY = "backup_schedule";
export const BACKUP_LAST_RUN_KEY = "backup_last_run_date";
export const AUDIT_RETENTION_KEY = "audit_retention_days";

export const DEFAULT_BACKUP_SCHEDULE: BackupScheduleSettings = {
  enabled: false,
  timeOfDay: "03:00",
  retentionPerRouter: 30,
};

export async function getBackupSchedule(): Promise<BackupScheduleSettings> {
  return getSetting(BACKUP_SCHEDULE_KEY, DEFAULT_BACKUP_SCHEDULE);
}
