// ─── Router Management Routes ───────────────────────────────────────
// CRUD for SSH-managed devices (routers), plus bulk import from CSV/Excel
// and TCP-based reachability checks for real-time status indicators.

import { Router, type IRouter } from "express";
import { db, routersTable, deviceReachabilityTable } from "@workspace/db";
import { eq, inArray, and, gte, sql } from "drizzle-orm";
import { CreateRouterBody, UpdateRouterBody } from "@workspace/api-zod";
import { requireAuth } from "../lib/auth.js";
import { executeSSH } from "../lib/ssh.js";
import * as net from "net";

const router: IRouter = Router();

// Strip the SSH password from responses to avoid leaking credentials to the frontend
function sanitizeRouter(r: typeof routersTable.$inferSelect) {
  return {
    id: r.id,
    name: r.name,
    ipAddress: r.ipAddress,
    sshPort: r.sshPort,
    sshUsername: r.sshUsername,
    description: r.description,
    credentialProfileId: r.credentialProfileId ?? null,
    vendor: r.vendor ?? null,
    osVersion: r.osVersion ?? null,
    lastFingerprintAt: r.lastFingerprintAt ?? null,
    hasEnablePassword: !!r.enablePassword,
    createdAt: r.createdAt,
  };
}

// GET /routers — List all routers (column-selective: excludes sshPassword)
router.get("/routers", async (req, res) => {
  requireAuth(req);
  const routers = await db
    .select({
      id: routersTable.id,
      name: routersTable.name,
      ipAddress: routersTable.ipAddress,
      sshPort: routersTable.sshPort,
      sshUsername: routersTable.sshUsername,
      description: routersTable.description,
      credentialProfileId: routersTable.credentialProfileId,
      vendor: routersTable.vendor,
      osVersion: routersTable.osVersion,
      lastFingerprintAt: routersTable.lastFingerprintAt,
      enablePassword: routersTable.enablePassword,
      createdAt: routersTable.createdAt,
    })
    .from(routersTable)
    .orderBy(routersTable.name);
  res.json(routers.map((r) => ({
    id: r.id,
    name: r.name,
    ipAddress: r.ipAddress,
    sshPort: r.sshPort,
    sshUsername: r.sshUsername,
    description: r.description,
    credentialProfileId: r.credentialProfileId ?? null,
    vendor: r.vendor ?? null,
    osVersion: r.osVersion ?? null,
    lastFingerprintAt: r.lastFingerprintAt ?? null,
    hasEnablePassword: !!r.enablePassword,
    createdAt: r.createdAt,
  })));
});

// POST /routers — Create a single router
router.post("/routers", async (req, res) => {
  requireAuth(req);
  const parsed = CreateRouterBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request body" });
    return;
  }
  const { name, ipAddress, sshPort, sshUsername, sshPassword, description, credentialProfileId, enablePassword } = parsed.data as any;
  const [newRouter] = await db
    .insert(routersTable)
    .values({
      name,
      ipAddress,
      sshPort: sshPort ?? 22,
      sshUsername,
      sshPassword,
      description,
      credentialProfileId: credentialProfileId ?? null,
      enablePassword: enablePassword ?? null,
    })
    .returning();
  res.status(201).json(sanitizeRouter(newRouter));
});

// GET /routers/:id — Get a single router by ID.
// We use next() (rather than 404) when the id segment isn't numeric so that
// sibling routes like /routers/uptime and /routers/fingerprint-all — declared
// later in this file — still get a chance to match. Express matches routes in
// declaration order; this fall-through preserves correctness without forcing
// us to reorder every collection-level route.
router.get("/routers/:id", async (req, res, next) => {
  requireAuth(req);
  const id = parseInt(req.params.id);
  if (isNaN(id)) { next(); return; }
  const [r] = await db
    .select()
    .from(routersTable)
    .where(eq(routersTable.id, id))
    .limit(1);
  if (!r) {
    res.status(404).json({ error: "Router not found" });
    return;
  }
  res.json(sanitizeRouter(r));
});

// PUT /routers/:id — Update router fields (partial update — only provided fields are changed)
router.put("/routers/:id", async (req, res) => {
  requireAuth(req);
  const id = parseInt(req.params.id);
  const parsed = UpdateRouterBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request body" });
    return;
  }
  const { name, ipAddress, sshPort, sshUsername, sshPassword, description, credentialProfileId, enablePassword } = parsed.data as any;
  const updates: Record<string, any> = {};
  if (name !== undefined) updates.name = name;
  if (ipAddress !== undefined) updates.ipAddress = ipAddress;
  if (sshPort !== undefined) updates.sshPort = sshPort;
  if (sshUsername !== undefined) updates.sshUsername = sshUsername;
  if (sshPassword !== undefined) updates.sshPassword = sshPassword;
  if (description !== undefined) updates.description = description;
  // credentialProfileId may be explicitly null to detach a profile.
  if (credentialProfileId !== undefined) updates.credentialProfileId = credentialProfileId;
  if (enablePassword !== undefined) updates.enablePassword = enablePassword;

  const [updated] = await db
    .update(routersTable)
    .set(updates)
    .where(eq(routersTable.id, id))
    .returning();
  if (!updated) {
    res.status(404).json({ error: "Router not found" });
    return;
  }
  res.json(sanitizeRouter(updated));
});

// DELETE /routers/:id — Remove a router
router.delete("/routers/:id", async (req, res) => {
  requireAuth(req);
  await db.delete(routersTable).where(eq(routersTable.id, parseInt(req.params.id)));
  res.json({ message: "Router deleted" });
});

// POST /routers/import — Bulk import routers from CSV/Excel data.
// Attempts a single batch insert first; if that fails (e.g. duplicate name),
// falls back to inserting one-by-one so partial success is possible.
router.post("/routers/import", async (req, res) => {
  requireAuth(req);
  const { routers: items } = req.body as { routers: any[] };
  if (!Array.isArray(items) || items.length === 0) {
    res.status(400).json({ error: "No routers provided" });
    return;
  }
  if (items.length > 10000) {
    res.status(400).json({ error: "Too many routers (max 10,000 per import)" });
    return;
  }

  const results: { index: number; name: string; status: "created" | "error"; error?: string }[] = [];
  let created = 0;
  let failed = 0;

  // Phase 1: Validate all rows and build insert values
  const validRows: { index: number; name: string; values: typeof routersTable.$inferInsert }[] = [];

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const name = (item.name || "").toString().trim();
    const ipAddress = (item.ipAddress || "").toString().trim();
    const sshUsername = (item.sshUsername || "admin").toString().trim();
    const sshPort = parseInt(item.sshPort) || 22;
    const sshPassword = (item.sshPassword || "").toString().trim() || undefined;
    const description = (item.description || "").toString().trim() || undefined;

    if (!name || !ipAddress) {
      results.push({ index: i, name: name || `Row ${i + 1}`, status: "error", error: "Missing name or IP address" });
      failed++;
      continue;
    }

    validRows.push({ index: i, name, values: { name, ipAddress, sshPort, sshUsername, sshPassword, description } });
  }

  // Phase 2: Try batch insert first (fast path), fall back to individual inserts on error
  if (validRows.length > 0) {
    try {
      await db.insert(routersTable).values(validRows.map((r) => r.values));
      for (const row of validRows) {
        results.push({ index: row.index, name: row.name, status: "created" });
        created++;
      }
    } catch (err: any) {
      // Batch failed — retry each row individually to allow partial success
      for (const row of validRows) {
        try {
          await db.insert(routersTable).values(row.values);
          results.push({ index: row.index, name: row.name, status: "created" });
          created++;
        } catch (rowErr: any) {
          results.push({ index: row.index, name: row.name, status: "error", error: rowErr.message });
          failed++;
        }
      }
    }
  }

  res.json({ created, failed, total: items.length, results });
});

// ─── Reachability Check ─────────────────────────────────────────────
// Attempts a TCP connection to each router's SSH port to determine
// if the device is reachable. Used by the frontend for status indicators.

// Try to open a TCP socket to host:port within the timeout window
function checkPort(host: string, port: number, timeoutMs = 3000): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let resolved = false;
    const done = (result: boolean) => {
      if (resolved) return;
      resolved = true;
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
    socket.connect(port, host);
  });
}

// POST /routers/check-reachability — Check SSH port reachability for multiple routers in parallel
router.post("/routers/check-reachability", async (req, res) => {
  requireAuth(req);
  const { routerIds } = req.body as { routerIds: number[] };
  if (!Array.isArray(routerIds) || routerIds.length === 0) {
    res.json({});
    return;
  }

  // Validate input: max 500 IDs, all must be positive integers
  if (routerIds.length > 500 || !routerIds.every((id) => Number.isInteger(id) && id > 0)) {
    res.status(400).json({ error: "Invalid routerIds (max 500 integer IDs)" });
    return;
  }

  // Fetch only the fields needed for the TCP check
  const routers = await db
    .select({ id: routersTable.id, ipAddress: routersTable.ipAddress, sshPort: routersTable.sshPort })
    .from(routersTable)
    .where(inArray(routersTable.id, routerIds));

  // Check all routers in parallel
  const results: Record<number, boolean> = {};
  await Promise.all(
    routers.map(async (r) => {
      results[r.id] = await checkPort(r.ipAddress, r.sshPort ?? 22);
    })
  );

  res.json(results);
});

// ─── Uptime / reachability history ──────────────────────────────────

// Helper: produce the last `days` ISO date strings (YYYY-MM-DD) ending today
function lastNDays(days: number): string[] {
  const out: string[] = [];
  const today = new Date();
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

// GET /routers/uptime — Bulk current uptime (% over last N days, default 30) for every router
router.get("/routers/uptime", async (req, res) => {
  requireAuth(req);
  const days = Math.max(1, Math.min(365, parseInt(String(req.query.days ?? "30")) || 30));
  const sinceDate = new Date();
  sinceDate.setDate(sinceDate.getDate() - (days - 1));
  const sinceIso = sinceDate.toISOString().slice(0, 10);
  const rows = await db
    .select({
      routerId: deviceReachabilityTable.routerId,
      total: sql<number>`SUM(${deviceReachabilityTable.totalChecks})::int`,
      success: sql<number>`SUM(${deviceReachabilityTable.successCount})::int`,
    })
    .from(deviceReachabilityTable)
    .where(gte(deviceReachabilityTable.day, sinceIso))
    .groupBy(deviceReachabilityTable.routerId);
  const out: Record<number, { uptimePercent: number; totalChecks: number; successCount: number }> = {};
  for (const r of rows) {
    const total = Number(r.total) || 0;
    const success = Number(r.success) || 0;
    out[r.routerId] = {
      uptimePercent: total === 0 ? 0 : Math.round((success / total) * 1000) / 10,
      totalChecks: total,
      successCount: success,
    };
  }
  res.json(out);
});

// GET /routers/:id/uptime?days=30 — Daily uptime series for sparkline
router.get("/routers/:id/uptime", async (req, res) => {
  requireAuth(req);
  const id = parseInt(req.params.id);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid router ID" }); return; }
  const days = Math.max(1, Math.min(365, parseInt(String(req.query.days ?? "30")) || 30));
  const sinceDate = new Date();
  sinceDate.setDate(sinceDate.getDate() - (days - 1));
  const sinceIso = sinceDate.toISOString().slice(0, 10);
  const rows = await db
    .select()
    .from(deviceReachabilityTable)
    .where(and(eq(deviceReachabilityTable.routerId, id), gte(deviceReachabilityTable.day, sinceIso)));
  const byDay = new Map<string, { total: number; success: number }>();
  for (const r of rows) byDay.set(r.day, { total: r.totalChecks, success: r.successCount });
  const series = lastNDays(days).map((d) => {
    const v = byDay.get(d) ?? { total: 0, success: 0 };
    return {
      day: d,
      totalChecks: v.total,
      successCount: v.success,
      uptimePercent: v.total === 0 ? null : Math.round((v.success / v.total) * 1000) / 10,
    };
  });
  let totalChecks = 0, successCount = 0;
  for (const v of byDay.values()) { totalChecks += v.total; successCount += v.success; }
  // Response shape matches OpenAPI RouterUptime: { routerId, uptimePercent, days[] }.
  res.json({
    routerId: id,
    uptimePercent: totalChecks === 0 ? 0 : Math.round((successCount / totalChecks) * 1000) / 10,
    days: series.map((s) => ({
      day: s.day,
      totalChecks: s.totalChecks,
      successCount: s.successCount,
    })),
  });
});

// ─── Fingerprint (vendor / OS detection) ─────────────────────────────
// Opens a single SSH session and tries vendor-specific commands in order.
// First one that yields parseable output wins. Persists vendor + osVersion
// + lastFingerprintAt on the router row.
//
// We intentionally use a short timeout (15s) because slow/non-responsive
// devices should fall through to the next command rather than blocking the
// whole detection chain.
async function fingerprintOne(routerId: number): Promise<{ success: boolean; vendor?: string | null; osVersion?: string | null; errorMessage?: string | null }> {
  const [r] = await db.select().from(routersTable).where(eq(routersTable.id, routerId)).limit(1);
  if (!r) return { success: false, errorMessage: "Router not found" };
  const username = r.sshUsername || "admin";
  const password = r.sshPassword || "";
  const port = r.sshPort || 22;

  // Ordered detection probes. Each entry: { cmd, parse(out) → {vendor, osVersion} | null }
  const probes: Array<{ cmd: string; parse: (out: string) => { vendor: string; osVersion: string | null } | null }> = [
    {
      // MikroTik RouterOS
      cmd: "/system resource print",
      parse: (out) => {
        const ver = /version:\s*([^\r\n]+)/i.exec(out);
        if (ver) return { vendor: "MikroTik", osVersion: `RouterOS ${ver[1].trim()}` };
        return null;
      },
    },
    {
      // Cisco IOS / IOS-XE
      cmd: "show version | include Software",
      parse: (out) => {
        const m = /Cisco IOS[^\n]*Version\s+([^\s,]+)/i.exec(out);
        if (m) return { vendor: "Cisco", osVersion: `IOS ${m[1]}` };
        return null;
      },
    },
    {
      // Generic Linux
      cmd: "uname -a; lsb_release -a 2>/dev/null || cat /etc/os-release 2>/dev/null",
      parse: (out) => {
        const distro =
          /PRETTY_NAME="?([^"\n]+)/i.exec(out)?.[1] ||
          /Description:\s*(.+)/i.exec(out)?.[1];
        if (distro) return { vendor: "Linux", osVersion: distro.trim() };
        if (/Linux\s+\S+\s+(\S+)/.test(out)) return { vendor: "Linux", osVersion: /Linux\s+\S+\s+(\S+)/.exec(out)![1] };
        return null;
      },
    },
  ];

  let lastErr = "";
  for (const probe of probes) {
    try {
      const result = await executeSSH(r.ipAddress, port, username, password, probe.cmd, {
        timeoutMs: 15_000,
        autoConfirm: true,
      });
      if (!result.success) {
        lastErr = result.errorMessage || "ssh failed";
        // If the SSH connection itself failed (auth/network), no point trying
        // the next probe — they'll all fail the same way.
        if (/auth|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EHOSTUNREACH/i.test(lastErr)) break;
        continue;
      }
      const parsed = probe.parse(result.output || "");
      if (parsed) {
        await db
          .update(routersTable)
          .set({ vendor: parsed.vendor, osVersion: parsed.osVersion, lastFingerprintAt: new Date() })
          .where(eq(routersTable.id, routerId));
        return { success: true, vendor: parsed.vendor, osVersion: parsed.osVersion };
      }
    } catch (err: any) {
      lastErr = String(err?.message || err);
    }
  }
  return { success: false, errorMessage: lastErr || "no probe matched" };
}

router.post("/routers/:id/fingerprint", async (req, res) => {
  requireAuth(req);
  const id = parseInt(req.params.id);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid router ID" }); return; }
  const result = await fingerprintOne(id);
  res.json(result);
});

router.post("/routers/fingerprint-all", async (req, res) => {
  requireAuth(req);
  const all = await db.select({ id: routersTable.id }).from(routersTable);
  let successCount = 0, failedCount = 0;
  // Bounded concurrency — fingerprinting is SSH-bound and we don't want to
  // open hundreds of sockets at once on large fleets.
  const CONCURRENCY = 10;
  let cursor = 0;
  const worker = async () => {
    while (cursor < all.length) {
      const r = all[cursor++];
      const out = await fingerprintOne(r.id);
      if (out.success) successCount++; else failedCount++;
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, all.length) }, worker));
  res.json({ successCount, failedCount });
});

export default router;
export { checkPort };
