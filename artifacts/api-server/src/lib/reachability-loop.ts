// ─── Background reachability poller ─────────────────────────────────
// Every REACHABILITY_INTERVAL_MS, opens a TCP probe to each router's SSH
// port and increments today's row in device_reachability. Used by the
// uptime endpoints + sparklines on the devices page.
//
// Design notes:
//  - We aggregate per (routerId, day) to keep the table small (one row per
//    device per day).
//  - We use Postgres' ON CONFLICT … DO UPDATE so concurrent inserts and the
//    initial seed both work without a separate "create row" step.
//  - The loop runs in-process — fine for single-instance deployments. For
//    horizontal scaling, this should move to a dedicated worker.

import * as net from "net";
import { db, routersTable, deviceReachabilityTable } from "@workspace/db";
import { sql } from "drizzle-orm";

const INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const PROBE_TIMEOUT_MS = 3000;
const MAX_CONCURRENCY = 25;

let intervalHandle: ReturnType<typeof setInterval> | null = null;
let inFlight = false;

function probe(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let done = false;
    const finish = (ok: boolean) => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(PROBE_TIMEOUT_MS);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
    socket.connect(port, host);
  });
}

async function tick(): Promise<void> {
  if (inFlight) return;
  inFlight = true;
  try {
    const routers = await db
      .select({ id: routersTable.id, ipAddress: routersTable.ipAddress, sshPort: routersTable.sshPort })
      .from(routersTable);
    if (routers.length === 0) return;

    const today = new Date().toISOString().slice(0, 10);

    // Bounded concurrency probe
    let cursor = 0;
    const workers: Promise<void>[] = [];
    const results: Array<{ id: number; ok: boolean }> = [];
    const worker = async () => {
      while (cursor < routers.length) {
        const idx = cursor++;
        const r = routers[idx];
        const ok = await probe(r.ipAddress, r.sshPort ?? 22);
        results.push({ id: r.id, ok });
      }
    };
    for (let i = 0; i < Math.min(MAX_CONCURRENCY, routers.length); i++) workers.push(worker());
    await Promise.all(workers);

    // Single bulk upsert for every router probed this tick. The EXCLUDED
    // values come from the VALUES list, so we add them to the existing row
    // (or use them directly when the row didn't yet exist).
    if (results.length > 0) {
      await db
        .insert(deviceReachabilityTable)
        .values(
          results.map(({ id, ok }) => ({
            routerId: id,
            day: today,
            totalChecks: 1,
            successCount: ok ? 1 : 0,
          })),
        )
        .onConflictDoUpdate({
          target: [deviceReachabilityTable.routerId, deviceReachabilityTable.day],
          set: {
            totalChecks: sql`${deviceReachabilityTable.totalChecks} + EXCLUDED.${sql.identifier("total_checks")}`,
            successCount: sql`${deviceReachabilityTable.successCount} + EXCLUDED.${sql.identifier("success_count")}`,
          },
        });
    }
  } catch (err) {
    console.error("[Reachability] tick failed:", err);
  } finally {
    inFlight = false;
  }
}

export function startReachabilityLoop(): void {
  if (intervalHandle) return;
  console.log(`[Reachability] Started (every ${INTERVAL_MS / 1000}s)`);
  intervalHandle = setInterval(tick, INTERVAL_MS);
  // Initial tick after a small delay so server fully boots before probing
  setTimeout(() => { tick().catch(() => {}); }, 5000);
}

export function stopReachabilityLoop(): void {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
  }
}
