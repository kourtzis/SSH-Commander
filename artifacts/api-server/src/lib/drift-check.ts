// ─── Drift check service ────────────────────────────────────────────
// Shared by the golden-config routes (operator-triggered check button) and
// the maintenance loop (daily pass + after each scheduled fleet backup), so
// drift verdicts and drift_detected alerts stay current without anyone
// opening the Drift page.
//
// Checks are DB-only: each member's LATEST successful backup is compared
// against the baseline (both sides normalized, ignore patterns applied).
// No SSH happens here — run backups first if you want fresh data.

import {
  db,
  goldenConfigsTable,
  driftResultsTable,
  configBackupsTable,
  routersTable,
} from "@workspace/db";
import { and, desc, eq, inArray } from "drizzle-orm";
import { resolveRouterIds } from "./resolve-routers.js";
import { normalizeForCompare, computeConfigDiff } from "./config-normalize.js";
import { emitAlert } from "./alerts.js";
import { childLogger } from "./logger.js";

const log = childLogger("drift-check");

type GoldenRow = typeof goldenConfigsTable.$inferSelect;
type DriftResultRow = typeof driftResultsTable.$inferSelect;

export interface DriftCheckSummary {
  results: DriftResultRow[];
  checked: number;
  drifted: number;
  skipped: number;
}

export async function runDriftCheckForGolden(golden: GoldenRow): Promise<DriftCheckSummary> {
  const memberIds = await resolveRouterIds([], [golden.groupId]);
  const members = memberIds.length > 0
    ? await db.select().from(routersTable).where(inArray(routersTable.id, memberIds))
    : [];

  const goldenNorm = normalizeForCompare(golden.content, golden.ignorePatterns ?? []);
  const results: DriftResultRow[] = [];
  let drifted = 0;
  let skipped = 0;

  for (const member of members) {
    const [latest] = await db.select().from(configBackupsTable)
      .where(and(eq(configBackupsTable.routerId, member.id), eq(configBackupsTable.status, "success")))
      .orderBy(desc(configBackupsTable.createdAt))
      .limit(1);
    if (!latest) {
      skipped++;
      // No backup — remove any stale verdict so the UI doesn't show
      // an old result for a router we can no longer evaluate.
      await db.delete(driftResultsTable).where(and(
        eq(driftResultsTable.goldenConfigId, golden.id),
        eq(driftResultsTable.routerId, member.id),
      ));
      continue;
    }
    const deviceNorm = normalizeForCompare(latest.content, golden.ignorePatterns ?? []);
    const cmp = computeConfigDiff(goldenNorm, deviceNorm, {
      expected: `golden: ${golden.name}`,
      actual: `${member.name} (backup #${latest.id})`,
    });
    if (!cmp.inSync) drifted++;
    const [row] = await db.insert(driftResultsTable).values({
      goldenConfigId: golden.id,
      routerId: member.id,
      routerName: member.name,
      routerIp: member.ipAddress,
      backupId: latest.id,
      inSync: cmp.inSync,
      addedLines: cmp.addedLines,
      removedLines: cmp.removedLines,
      diff: cmp.inSync ? null : cmp.diff,
      checkedAt: new Date(),
    }).onConflictDoUpdate({
      target: [driftResultsTable.goldenConfigId, driftResultsTable.routerId],
      set: {
        routerName: member.name,
        routerIp: member.ipAddress,
        backupId: latest.id,
        inSync: cmp.inSync,
        addedLines: cmp.addedLines,
        removedLines: cmp.removedLines,
        diff: cmp.inSync ? null : cmp.diff,
        checkedAt: new Date(),
      },
    }).returning();
    results.push(row);
  }

  if (drifted > 0) {
    const driftedNames = results.filter((r) => !r.inSync).map((r) => r.routerName).slice(0, 10);
    void emitAlert("drift_detected", {
      subject: `Config drift detected: ${golden.name}`,
      message: `${drifted} of ${results.length} device(s) drifted from the baseline "${golden.name}": ${driftedNames.join(", ")}${drifted > 10 ? ", ..." : ""}`,
      entityKey: `golden:${golden.id}`,
    });
  }

  return { results, checked: results.length, drifted, skipped };
}

/** Run every golden config's check; failures on one baseline never block the rest. */
export async function runAllDriftChecks(): Promise<{ goldens: number; checked: number; drifted: number; skipped: number }> {
  const goldens = await db.select().from(goldenConfigsTable);
  let checked = 0;
  let drifted = 0;
  let skipped = 0;
  for (const golden of goldens) {
    try {
      const summary = await runDriftCheckForGolden(golden);
      checked += summary.checked;
      drifted += summary.drifted;
      skipped += summary.skipped;
    } catch (err) {
      log.warn({ err, goldenId: golden.id }, "drift check failed for golden config");
    }
  }
  return { goldens: goldens.length, checked, drifted, skipped };
}
