// ─── Daily maintenance loop ─────────────────────────────────────────
// One lightweight 30s ticker that owns three responsibilities:
//   1. Scheduled config backups — fires once per day when the server-local
//      HH:MM matches the operator-configured time. The "already ran today"
//      marker lives in app_settings (not memory) so a server restart at
//      03:01 doesn't re-run the 03:00 backup.
//   2. Retention sweeps — audit_log rows beyond the configured retention
//      (default 90 days) and alert_events beyond 90 days, once per day.
//   3. Golden-config drift checks — re-evaluated once per day and right
//      after each scheduled fleet backup, so drift verdicts and alerts
//      stay current without an operator opening the Drift page.

import { db, routersTable, auditLogTable, alertEventsTable } from "@workspace/db";
import { lt, sql } from "drizzle-orm";
import { getBackupSchedule, getSetting, setSetting, BACKUP_LAST_RUN_KEY, AUDIT_RETENTION_KEY } from "./app-settings.js";
import { runBackupsForRouters } from "./backups.js";
import { runAllDriftChecks } from "./drift-check.js";
import { logAuditSystem } from "./audit.js";
import { childLogger } from "./logger.js";

const log = childLogger("maintenance");

const TICK_MS = 30_000;
let intervalHandle: ReturnType<typeof setInterval> | null = null;
let inFlight = false;
let lastSweepDate = ""; // in-memory is fine for the sweep — running it twice is harmless
let lastDriftDate = ""; // same: drift checks are cheap DB-only diffs, re-running is harmless

function todayStr(): string {
  return new Date().toISOString().slice(0, 10);
}

function currentHHMM(): string {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

async function maybeRunScheduledBackups(): Promise<void> {
  const schedule = await getBackupSchedule();
  if (!schedule.enabled) return;
  if (currentHHMM() !== schedule.timeOfDay) return;

  const marker = await getSetting<{ date: string }>(BACKUP_LAST_RUN_KEY, { date: "" });
  const today = todayStr();
  if (marker.date === today) return;

  // Claim the run BEFORE doing the work so a crash mid-run doesn't
  // re-trigger a full fleet backup every 30s for the rest of the minute.
  await setSetting(BACKUP_LAST_RUN_KEY, { date: today });

  const routers = await db.select({ id: routersTable.id }).from(routersTable);
  if (routers.length === 0) return;
  log.info({ count: routers.length }, "starting scheduled fleet backup");
  const summary = await runBackupsForRouters(routers.map((r) => r.id), "scheduled", null);
  await logAuditSystem("backup.scheduled_run", {
    resourceType: "backup",
    details: { ...summary },
  });

  // Fresh fleet backups are exactly when drift verdicts change — re-check now.
  await maybeRunDriftChecks(true);
}

async function maybeRunDriftChecks(force: boolean): Promise<void> {
  const today = todayStr();
  if (!force && lastDriftDate === today) return;
  lastDriftDate = today;

  const summary = await runAllDriftChecks();
  if (summary.goldens === 0) return;
  log.info(summary, "drift check pass done");
  await logAuditSystem("golden.scheduled_check", {
    resourceType: "golden_config",
    details: { ...summary },
  });
}

async function maybeSweepRetention(): Promise<void> {
  const today = todayStr();
  if (lastSweepDate === today) return;
  lastSweepDate = today;

  const retention = await getSetting<{ days: number }>(AUDIT_RETENTION_KEY, { days: 90 });
  const days = Math.max(7, retention.days || 90);
  const audit = await db.delete(auditLogTable)
    .where(lt(auditLogTable.createdAt, sql`now() - make_interval(days => ${days})`));
  const events = await db.delete(alertEventsTable)
    .where(lt(alertEventsTable.createdAt, sql`now() - interval '90 days'`));
  log.info({ auditRetentionDays: days }, "retention sweep done");
  void audit;
  void events;
}

async function tick(): Promise<void> {
  if (inFlight) return;
  inFlight = true;
  try {
    await maybeRunScheduledBackups();
    await maybeSweepRetention();
    await maybeRunDriftChecks(false);
  } catch (err) {
    log.warn({ err }, "maintenance tick failed");
  } finally {
    inFlight = false;
  }
}

export function startMaintenanceLoop(): void {
  if (intervalHandle) return;
  log.info("Maintenance loop started (30s tick: scheduled backups + retention sweeps)");
  intervalHandle = setInterval(tick, TICK_MS);
  setTimeout(() => { tick().catch(() => {}); }, 10_000);
}

export function stopMaintenanceLoop(): void {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
  }
}
