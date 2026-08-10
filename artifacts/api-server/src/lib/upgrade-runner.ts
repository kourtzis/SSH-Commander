// ─── RouterOS upgrade orchestrator ──────────────────────────────────
// Runs an upgrade_runs row to completion. Per device the pipeline is:
//
//   pending → (backing_up) → upgrading → rebooting → verifying → success/failed
//
// Design notes:
//  * Deliberately separate from the batch-jobs engine — an upgrade is a
//    multi-phase state machine with an expected SSH disconnect (reboot)
//    and reachability polling, not a single script execution.
//  * Verification is version-based, not merely "port came back": after
//    `/system package update install` the device may keep its SSH port
//    open for minutes while downloading packages, so we poll the actual
//    reported version until it CHANGES (or we time out). A device that
//    comes back with the same version is a failed upgrade, loudly.
//  * Concurrency is a conservative 3 — mass-rebooting a fleet is exactly
//    the kind of thing an orchestrator exists to prevent.

import * as net from "net";
import { db, routersTable, upgradeRunsTable, upgradeTasksTable } from "@workspace/db";
import { and, eq, sql } from "drizzle-orm";
import { executeSSH, stripAnsi } from "./ssh.js";
import { resolveEffectiveCreds, type EffectiveCreds } from "./effective-creds.js";
import { runBackupForRouter } from "./backups.js";
import { emitAlert } from "./alerts.js";
import { childLogger } from "./logger.js";

const log = childLogger("upgrades");

const CONCURRENCY = 3;
const VERIFY_BUDGET_MS = 10 * 60 * 1000; // total wait for reboot + version change
const REBOOT_GRACE_MS = 30_000;          // let the install/reboot actually begin
const PROBE_INTERVAL_MS = 10_000;
const VERSION_POLL_INTERVAL_MS = 20_000;

type RouterRow = typeof routersTable.$inferSelect;
type TaskRow = typeof upgradeTasksTable.$inferSelect;

function tcpProbe(host: string, port: number, timeoutMs = 3000): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let done = false;
    const finish = (ok: boolean) => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
    socket.connect(port, host);
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function appendLog(taskId: number, message: string): Promise<void> {
  const line = `[${new Date().toISOString().slice(11, 19)}] ${message}\n`;
  await db.update(upgradeTasksTable)
    .set({ log: sql`${upgradeTasksTable.log} || ${line}` })
    .where(eq(upgradeTasksTable.id, taskId))
    .catch?.(() => {});
}

async function setTask(taskId: number, patch: Partial<typeof upgradeTasksTable.$inferInsert>): Promise<void> {
  await db.update(upgradeTasksTable).set(patch).where(eq(upgradeTasksTable.id, taskId));
}

function sshExec(router: RouterRow, creds: EffectiveCreds, command: string, timeoutMs: number) {
  const username = `${creds.username || "admin"}+cte`; // clean, pager-free output on RouterOS
  return executeSSH(router.ipAddress, router.sshPort || 22, username, creds.password, command, {
    timeoutMs,
    autoConfirm: true,
    enablePassword: creds.enablePassword,
    jumpHost: creds.jumpHost,
    useLegacyAlgorithms: creds.useLegacyAlgorithms,
    retryCount: 0,
    hostKeyTrust: { routerId: router.id, expectedFingerprint: router.sshHostKeyFingerprint ?? null },
  });
}

/** Find a line that is exactly a RouterOS version ("7.15.3" or "7.15.3 (stable)"). */
function parseVersion(raw: string): string | null {
  const m = /^\s*(\d+\.\d+(?:\.\d+)?(?:\s*\([^)]+\))?)\s*$/m.exec(stripAnsi(raw));
  return m ? m[1].trim() : null;
}

async function probeVersion(router: RouterRow, creds: EffectiveCreds, timeoutMs = 25_000): Promise<string | null> {
  const res = await sshExec(router, creds, ":put [/system resource get version]", timeoutMs);
  if (!res.success) return null;
  return parseVersion(res.output || "");
}

// ─── Per-device pipeline ────────────────────────────────────────────

async function runTask(run: typeof upgradeRunsTable.$inferSelect, task: TaskRow): Promise<"success" | "failed" | "skipped"> {
  const taskId = task.id;
  const fail = async (message: string): Promise<"failed"> => {
    await appendLog(taskId, `FAILED: ${message}`);
    await setTask(taskId, { status: "failed", errorMessage: message.slice(0, 1000), completedAt: new Date() });
    return "failed";
  };

  const [router] = await db.select().from(routersTable).where(eq(routersTable.id, task.routerId)).limit(1);
  if (!router) return fail("Router no longer exists");

  const vendor = (router.vendor ?? "").toLowerCase();
  if (vendor && !vendor.includes("mikrotik")) {
    await appendLog(taskId, `Skipped: vendor "${router.vendor}" — RouterOS upgrades only`);
    await setTask(taskId, { status: "skipped", errorMessage: "Only MikroTik RouterOS devices can be upgraded", completedAt: new Date() });
    return "skipped";
  }

  const creds = await resolveEffectiveCreds(router);
  if (!creds.password) return fail("No SSH password configured (check the credential profile or set an inline password)");

  await setTask(taskId, { startedAt: new Date() });

  // Step 0: live version probe — confirms reachability + auth before we touch anything.
  await appendLog(taskId, `Probing current RouterOS version on ${router.ipAddress}...`);
  const liveVersion = await probeVersion(router, creds);
  const oldVersion = liveVersion ?? router.osVersion ?? null;
  if (!liveVersion) {
    if (!oldVersion) return fail("Device unreachable and no fingerprinted version on record");
    await appendLog(taskId, `Live probe failed — using fingerprinted version ${oldVersion}`);
    // If we can't even probe, the install step will fail anyway; bail early with a clear message.
    return fail("Device did not answer the version probe over SSH");
  }
  await setTask(taskId, { oldVersion });
  await appendLog(taskId, `Current version: ${oldVersion}`);

  // Step 1: pre-upgrade backup.
  if (run.preBackup) {
    await setTask(taskId, { status: "backing_up" });
    await appendLog(taskId, "Taking pre-upgrade config backup...");
    const backup = await runBackupForRouter(router, "pre_upgrade", run.createdBy ?? null);
    if (!backup.ok) return fail(`Pre-upgrade backup failed: ${backup.error ?? "unknown error"} — device left untouched`);
    await appendLog(taskId, backup.unchanged ? "Backup unchanged from latest snapshot" : `Backup saved (#${backup.backupId})`);
  }

  // Step 2: check for updates.
  await setTask(taskId, { status: "upgrading" });
  await appendLog(taskId, "Checking for updates (/system package update check-for-updates once)...");
  const check = await sshExec(router, creds, "/system package update check-for-updates once", 90_000);
  if (!check.success) return fail(`Update check failed: ${check.errorMessage || "SSH error"}`);
  const checkOut = stripAnsi(check.output || "");
  const latestMatch = /latest-version:\s*([^\s;]+)/i.exec(checkOut);
  const statusMatch = /status:\s*([^\n;]+)/i.exec(checkOut);
  const statusText = statusMatch?.[1]?.trim() ?? "";
  await appendLog(taskId, `Update check: ${statusText || "no status line"}${latestMatch ? ` (latest: ${latestMatch[1]})` : ""}`);

  if (/already up to date/i.test(checkOut)) {
    await setTask(taskId, { status: "success", newVersion: oldVersion, completedAt: new Date() });
    await appendLog(taskId, "Already up to date — nothing to install.");
    return "success";
  }
  if (!latestMatch && !/new version is available/i.test(checkOut)) {
    return fail(`Could not determine update availability from device output: ${checkOut.slice(0, 300)}`);
  }

  // Step 3: install (device downloads packages and reboots — SSH will drop).
  await appendLog(taskId, "Installing update (/system package update install) — device will reboot...");
  const install = await sshExec(router, creds, "/system package update install", 45_000);
  if (!install.success && install.errorMessage && /auth/i.test(install.errorMessage)) {
    // A dropped connection is EXPECTED here; an auth failure is not.
    return fail(`Install command failed: ${install.errorMessage}`);
  }
  await appendLog(taskId, "Install dispatched. Waiting for device to reboot...");

  // Step 4: wait out the reboot, then verify by version change.
  await setTask(taskId, { status: "rebooting" });
  await sleep(REBOOT_GRACE_MS);

  const deadline = Date.now() + VERIFY_BUDGET_MS;
  let verifying = false;
  let lastSeenVersion: string | null = null;
  while (Date.now() < deadline) {
    const portOpen = await tcpProbe(router.ipAddress, router.sshPort || 22);
    if (!portOpen) {
      if (verifying) await appendLog(taskId, "Port closed again (reboot in progress)...");
      verifying = false;
      await sleep(PROBE_INTERVAL_MS);
      continue;
    }
    if (!verifying) {
      verifying = true;
      await setTask(taskId, { status: "verifying" });
      await appendLog(taskId, "SSH port is open — verifying installed version...");
    }
    const v = await probeVersion(router, creds, 20_000);
    if (v) {
      lastSeenVersion = v;
      if (v !== oldVersion) {
        await setTask(taskId, { status: "success", newVersion: v, completedAt: new Date() });
        await appendLog(taskId, `Upgrade verified: ${oldVersion} → ${v}`);
        await db.update(routersTable)
          .set({ osVersion: v, lastFingerprintAt: new Date() })
          .where(eq(routersTable.id, router.id))
          .catch?.(() => {});
        return "success";
      }
      await appendLog(taskId, `Device still reports ${v} — waiting for reboot to apply the update...`);
    }
    await sleep(VERSION_POLL_INTERVAL_MS);
  }

  if (lastSeenVersion === oldVersion) {
    return fail(`Device came back with unchanged version ${oldVersion} — the update did not apply (check package architecture / disk space on the device)`);
  }
  return fail("Device did not come back within the 10-minute verification window");
}

// ─── Run driver ─────────────────────────────────────────────────────

export async function startUpgradeRun(runId: number): Promise<void> {
  const [run] = await db.select().from(upgradeRunsTable).where(eq(upgradeRunsTable.id, runId)).limit(1);
  if (!run) {
    log.warn({ runId }, "startUpgradeRun: run not found");
    return;
  }
  const tasks = await db.select().from(upgradeTasksTable)
    .where(and(eq(upgradeTasksTable.runId, runId), eq(upgradeTasksTable.status, "pending")))
    .orderBy(upgradeTasksTable.id);

  log.info({ runId, tasks: tasks.length }, "upgrade run started");
  let completed = 0; // success + skipped
  let failed = 0;

  let cursor = 0;
  const worker = async () => {
    while (cursor < tasks.length) {
      const task = tasks[cursor++];
      // Re-check cancellation before every device.
      const [current] = await db.select({ status: upgradeRunsTable.status })
        .from(upgradeRunsTable).where(eq(upgradeRunsTable.id, runId)).limit(1);
      if (current?.status === "cancelled") {
        await db.update(upgradeTasksTable)
          .set({ status: "skipped", errorMessage: "Run cancelled", completedAt: new Date() })
          .where(and(eq(upgradeTasksTable.id, task.id), eq(upgradeTasksTable.status, "pending")));
        completed++;
        continue;
      }
      try {
        const outcome = await runTask(run, task);
        if (outcome === "failed") failed++;
        else completed++;
      } catch (err: any) {
        failed++;
        log.error({ err, taskId: task.id }, "upgrade task crashed");
        await setTask(task.id, {
          status: "failed",
          errorMessage: (err?.message ?? "Unexpected error").slice(0, 1000),
          completedAt: new Date(),
        }).catch(() => {});
      }
      await db.update(upgradeRunsTable)
        .set({ completedTasks: completed, failedTasks: failed })
        .where(eq(upgradeRunsTable.id, runId))
        .catch?.(() => {});
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, tasks.length) }, () => worker()));

  const [finalRun] = await db.select().from(upgradeRunsTable).where(eq(upgradeRunsTable.id, runId)).limit(1);
  const finalStatus = finalRun?.status === "cancelled"
    ? "cancelled"
    : failed > 0 && completed === 0
      ? "failed"
      : failed > 0
        ? "completed" // partial — per-task statuses tell the story; run "failed" is reserved for total loss
        : "completed";
  await db.update(upgradeRunsTable)
    .set({ status: finalStatus as any, completedTasks: completed, failedTasks: failed, completedAt: new Date() })
    .where(eq(upgradeRunsTable.id, runId));

  const summary = `${run.name}: ${completed} succeeded/skipped, ${failed} failed (of ${tasks.length})`;
  if (failed > 0) {
    void emitAlert("upgrade_failed", {
      subject: `Upgrade run finished with failures: ${run.name}`,
      message: summary,
      entityKey: `upgrade:${runId}`,
    });
  } else if (finalStatus !== "cancelled") {
    void emitAlert("upgrade_completed", {
      subject: `Upgrade run completed: ${run.name}`,
      message: summary,
      entityKey: `upgrade:${runId}`,
    });
  }
  log.info({ runId, finalStatus, completed, failed }, "upgrade run finished");
}
