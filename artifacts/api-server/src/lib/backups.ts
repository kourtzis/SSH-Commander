// ─── Config backup runner ───────────────────────────────────────────
// Captures device configuration exports over SSH, deduplicates identical
// consecutive captures, and enforces per-router retention.
//
// Dedup: the content hash is computed over the NORMALIZED export (volatile
// header comments stripped), so RouterOS's per-capture timestamp comment
// doesn't defeat dedup. If the latest successful backup for the router has
// the same hash, no new row is written — lastSeenAt is bumped instead.

import { db, routersTable, configBackupsTable } from "@workspace/db";
import { and, desc, eq, inArray, lt, notInArray, sql } from "drizzle-orm";
import { executeSSH } from "./ssh.js";
import { resolveEffectiveCreds } from "./effective-creds.js";
import { cleanDeviceExport, normalizeForCompare, hashConfig } from "./config-normalize.js";
import { getBackupSchedule } from "./app-settings.js";
import { emitAlert } from "./alerts.js";
import { childLogger } from "./logger.js";

const log = childLogger("backups");

type RouterRow = typeof routersTable.$inferSelect;
export type BackupKind = "manual" | "scheduled" | "pre_upgrade";

export interface BackupOutcome {
  ok: boolean;
  unchanged: boolean;
  backupId: number | null;
  error?: string;
}

/** Vendor-aware export command. MikroTik gets the +cte user suffix (no
 *  colour / no terminal detect / no escapes) — the same trick the
 *  fingerprint probes use to keep output parseable. */
function exportPlan(router: RouterRow, username: string): { command: string; user: string } {
  const vendor = (router.vendor ?? "").toLowerCase();
  if (vendor.includes("cisco")) {
    return { command: "show running-config", user: username };
  }
  // Default to RouterOS — this is MikroManager, after all. Unknown vendors
  // get the MikroTik treatment; a failed export records a failed backup row
  // with the device's actual error output, which is the honest outcome.
  return { command: "/export", user: `${username}+cte` };
}

async function recordFailure(router: RouterRow, kind: BackupKind, createdBy: number | null, error: string): Promise<BackupOutcome> {
  const [row] = await db.insert(configBackupsTable).values({
    routerId: router.id,
    routerName: router.name,
    routerIp: router.ipAddress,
    kind,
    status: "failed",
    content: "",
    contentHash: "",
    sizeBytes: 0,
    errorMessage: error.slice(0, 2000),
    createdBy,
  }).returning({ id: configBackupsTable.id });
  void emitAlert("backup_failed", {
    subject: `Backup failed: ${router.name}`,
    message: `Config backup of ${router.name} (${router.ipAddress}) failed: ${error}`,
    routerId: router.id,
    entityKey: `router:${router.id}`,
  });
  return { ok: false, unchanged: false, backupId: row?.id ?? null, error };
}

export async function runBackupForRouter(
  router: RouterRow,
  kind: BackupKind,
  createdBy: number | null,
): Promise<BackupOutcome> {
  const creds = await resolveEffectiveCreds(router);
  if (!creds.password) {
    return recordFailure(router, kind, createdBy, "No SSH password configured (check the credential profile or set an inline password)");
  }
  const plan = exportPlan(router, creds.username || "admin");

  const result = await executeSSH(
    router.ipAddress,
    router.sshPort || 22,
    plan.user,
    creds.password,
    plan.command,
    {
      timeoutMs: 60_000,
      autoConfirm: true,
      enablePassword: creds.enablePassword,
      jumpHost: creds.jumpHost,
      useLegacyAlgorithms: creds.useLegacyAlgorithms,
      retryCount: 1,
      retryBackoffSeconds: 3,
      hostKeyTrust: { routerId: router.id, expectedFingerprint: router.sshHostKeyFingerprint ?? null },
    },
  );

  if (!result.success) {
    return recordFailure(router, kind, createdBy, result.errorMessage || "SSH execution failed");
  }

  const content = cleanDeviceExport(result.output || "");
  if (content.length < 10) {
    return recordFailure(router, kind, createdBy, "Device returned an empty export");
  }
  const contentHash = hashConfig(normalizeForCompare(content));

  // Dedup against the latest successful backup for this router.
  const [latest] = await db
    .select({ id: configBackupsTable.id, contentHash: configBackupsTable.contentHash })
    .from(configBackupsTable)
    .where(and(eq(configBackupsTable.routerId, router.id), eq(configBackupsTable.status, "success")))
    .orderBy(desc(configBackupsTable.createdAt))
    .limit(1);

  if (latest && latest.contentHash === contentHash) {
    await db.update(configBackupsTable)
      .set({ lastSeenAt: new Date() })
      .where(eq(configBackupsTable.id, latest.id));
    return { ok: true, unchanged: true, backupId: latest.id };
  }

  const [inserted] = await db.insert(configBackupsTable).values({
    routerId: router.id,
    routerName: router.name,
    routerIp: router.ipAddress,
    kind,
    status: "success",
    content,
    contentHash,
    sizeBytes: Buffer.byteLength(content, "utf8"),
    createdBy,
  }).returning({ id: configBackupsTable.id });

  await pruneRetention(router.id).catch((err) => log.warn({ err, routerId: router.id }, "retention prune failed"));
  return { ok: true, unchanged: false, backupId: inserted?.id ?? null };
}

/** Keep the newest N successful backups per router; failed rows older than
 *  7 days are swept too (they're diagnostics, not history). */
async function pruneRetention(routerId: number): Promise<void> {
  const settings = await getBackupSchedule();
  const keep = Math.max(1, settings.retentionPerRouter);

  const keepRows = await db
    .select({ id: configBackupsTable.id })
    .from(configBackupsTable)
    .where(and(eq(configBackupsTable.routerId, routerId), eq(configBackupsTable.status, "success")))
    .orderBy(desc(configBackupsTable.createdAt))
    .limit(keep);
  const keepIds = keepRows.map((r) => r.id);
  if (keepIds.length === keep) {
    await db.delete(configBackupsTable).where(and(
      eq(configBackupsTable.routerId, routerId),
      eq(configBackupsTable.status, "success"),
      notInArray(configBackupsTable.id, keepIds),
    ));
  }
  await db.delete(configBackupsTable).where(and(
    eq(configBackupsTable.routerId, routerId),
    eq(configBackupsTable.status, "failed"),
    lt(configBackupsTable.createdAt, sql`now() - interval '7 days'`),
  ));
}

export interface BackupRunSummary {
  total: number;
  succeeded: number;
  unchanged: number;
  failed: number;
}

/** Run backups for a set of routers with bounded concurrency. */
export async function runBackupsForRouters(
  routerIds: number[],
  kind: BackupKind,
  createdBy: number | null,
): Promise<BackupRunSummary> {
  if (routerIds.length === 0) return { total: 0, succeeded: 0, unchanged: 0, failed: 0 };
  const routers = await db.select().from(routersTable).where(inArray(routersTable.id, routerIds));

  const summary: BackupRunSummary = { total: routers.length, succeeded: 0, unchanged: 0, failed: 0 };
  let cursor = 0;
  const CONCURRENCY = 8;
  const worker = async () => {
    while (cursor < routers.length) {
      const r = routers[cursor++];
      try {
        const out = await runBackupForRouter(r, kind, createdBy);
        if (out.ok && out.unchanged) summary.unchanged++;
        else if (out.ok) summary.succeeded++;
        else summary.failed++;
      } catch (err: any) {
        summary.failed++;
        log.warn({ err, router: r.name }, "backup crashed");
        await recordFailure(r, kind, createdBy, err?.message ?? "Unexpected backup error").catch(() => {});
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, routers.length) }, () => worker()));
  log.info({ ...summary, kind }, "backup run finished");
  return summary;
}
