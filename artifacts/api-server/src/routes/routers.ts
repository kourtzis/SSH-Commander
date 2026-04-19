// ─── Router Management Routes ───────────────────────────────────────
// CRUD for SSH-managed devices (routers), plus bulk import from CSV/Excel
// and TCP-based reachability checks for real-time status indicators.

import { Router, type IRouter } from "express";
import { db, routersTable, deviceReachabilityTable } from "@workspace/db";
import { eq, inArray, and, gte, sql } from "drizzle-orm";
import { CreateRouterBody, UpdateRouterBody } from "@workspace/api-zod";
import { requireAuth } from "../lib/auth.js";
import { executeSSH } from "../lib/ssh.js";
import { resolveEffectiveCreds } from "../lib/effective-creds.js";
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
    model: r.model ?? null,
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
      model: routersTable.model,
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
    model: r.model ?? null,
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
  const id = parseInt(req.params.id);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid router id" }); return; }
  await db.delete(routersTable).where(eq(routersTable.id, id));
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
  // Single query for the daily rows across every router so the Devices page
  // can render every sparkline + percent without firing one HTTP request per
  // device row (which was the v1.7.0 page-load slowdown).
  const rows = await db
    .select({
      routerId: deviceReachabilityTable.routerId,
      day: deviceReachabilityTable.day,
      totalChecks: deviceReachabilityTable.totalChecks,
      successCount: deviceReachabilityTable.successCount,
    })
    .from(deviceReachabilityTable)
    .where(gte(deviceReachabilityTable.day, sinceIso));

  const dayList = lastNDays(days);
  const byRouter = new Map<number, Map<string, { total: number; success: number }>>();
  for (const r of rows) {
    let m = byRouter.get(r.routerId);
    if (!m) { m = new Map(); byRouter.set(r.routerId, m); }
    m.set(r.day, { total: r.totalChecks, success: r.successCount });
  }
  const out: Record<number, { uptimePercent: number; totalChecks: number; successCount: number; days: Array<{ day: string; totalChecks: number; successCount: number }> }> = {};
  for (const [rid, dayMap] of byRouter.entries()) {
    let total = 0, success = 0;
    const series = dayList.map((d) => {
      const v = dayMap.get(d) ?? { total: 0, success: 0 };
      total += v.total; success += v.success;
      return { day: d, totalChecks: v.total, successCount: v.success };
    });
    out[rid] = {
      uptimePercent: total === 0 ? 0 : Math.round((success / total) * 1000) / 10,
      totalChecks: total,
      successCount: success,
      days: series,
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
async function fingerprintOne(routerId: number): Promise<{ success: boolean; vendor?: string | null; osVersion?: string | null; model?: string | null; errorMessage?: string | null }> {
  const [r] = await db.select().from(routersTable).where(eq(routersTable.id, routerId)).limit(1);
  if (!r) return { success: false, errorMessage: "Router not found" };
  // Resolve the actual credentials (and any bastion) to use — devices
  // attached to a credential profile would previously be probed with
  // their (often empty) inline password, producing spurious auth
  // failures. The shared resolver gives us profile + jump-host support.
  const creds = await resolveEffectiveCreds(r);
  const username = creds.username || "admin";
  const password = creds.password || "";
  const port = r.sshPort || 22;
  if (!password) {
    // Don't even try the SSH probes — we know the auth will fail with
    // an unhelpful generic error. Return a clear message instead.
    return { success: false, errorMessage: "No SSH password configured (check the credential profile or set an inline password)" };
  }

  // Strip ANSI/VT100 escape sequences that MikroTik (and many other devices)
  // emit for colour, cursor moves, and terminal-type queries. These were
  // breaking the simple `version:` regex below — the literal "version:"
  // string had control chars wedged into the middle of it on RouterOS v7.
  const stripAnsi = (s: string): string =>
    s
      // CSI sequences (ESC [ … final-byte) — colours, cursor moves, DA queries
      .replace(/\x1b\[[\d;?]*[a-zA-Z]/g, "")
      // ESC ( charset selectors and other 2-byte escape sequences
      .replace(/\x1b[()][A-Za-z0-9]/g, "")
      // Bare ESC + single char (OSC, etc.)
      .replace(/\x1b./g, "")
      // Carriage returns from the pager
      .replace(/\r/g, "");

  // Ordered detection probes. Each entry: { cmd, parse(out) → {vendor, osVersion} | null }
  // Append `+cte` to the MikroTik probe usernames: RouterOS treats the suffix
  // as session flags — `c`=no colour, `t`=no terminal-type detect, `e`=no
  // escape sequences. Without it, /system resource print emits ANSI codes
  // and pagination prompts that scramble the output. Falls back to the bare
  // username if the device rejects the suffix (older RouterOS, non-MikroTik).
  const mtUser = `${username}+cte`;
  const probes: Array<{ cmd: string; user: string; parse: (out: string) => { vendor: string; osVersion: string | null; model: string | null } | null }> = [
    {
      // RouterOS v7+ — terse one-liner via scripting `:put`. Combined call
      // returns version on the first line and board-name (the hardware model,
      // e.g. "RB4011iGS+" or "CCR2004-1G-12S+2XS") on the second.
      cmd: ":put [/system resource get version]; :put [/system resource get board-name]",
      user: mtUser,
      parse: (raw) => {
        const out = stripAnsi(raw);
        const verMatch = /^\s*(\d+\.\d+(?:\.\d+)?(?:\s*\([^)]+\))?)\s*$/m.exec(out);
        if (!verMatch) return null;
        // Pick a board-name line: any non-empty line that isn't the version line itself.
        // RouterOS board names include letters, digits, +, -, /, parens.
        const verLine = verMatch[0];
        const boardLines = out.split(/\r?\n/)
          .map((s) => s.trim())
          .filter((s) => s.length > 0 && s !== verLine.trim() && /^[A-Za-z][A-Za-z0-9+\-/. ()]*$/.test(s));
        const model = boardLines[0] || null;
        return { vendor: "MikroTik", osVersion: `RouterOS ${verMatch[1].trim()}`, model };
      },
    },
    {
      // RouterOS v6/v7 — full resource dump. `version:` and `board-name:`
      // appear as separate labelled columns.
      cmd: "/system resource print",
      user: mtUser,
      parse: (raw) => {
        const out = stripAnsi(raw);
        const ver = /version\s*:\s*([^\r\n]+)/i.exec(out);
        const ros = /RouterOS\s+v?(\d+\.\d+(?:\.\d+)?(?:[A-Za-z0-9.\-]*)?)/i.exec(out);
        const board = /board-?name\s*:\s*([^\r\n]+)/i.exec(out);
        const osVersion = ver ? `RouterOS ${ver[1].trim()}` : ros ? `RouterOS ${ros[1]}` : null;
        if (!osVersion) return null;
        return { vendor: "MikroTik", osVersion, model: board?.[1].trim() || null };
      },
    },
    {
      // Cisco IOS / IOS-XE — `show version` includes both version and model.
      // Switched away from `| include Software` (too narrow) to capture model lines too.
      cmd: "show version",
      user: username,
      parse: (out) => {
        const ver = /Cisco IOS[^\n]*Version\s+([^\s,]+)/i.exec(out)
          || /Cisco IOS Software[^\n]*Version\s+([^\s,]+)/i.exec(out);
        if (!ver) return null;
        // Common Cisco model patterns: "cisco WS-C2960-...", "Model number : ...",
        // "cisco ISR4321/K9", "cisco C9300-24P". Try the explicit "Model" line first,
        // then the "cisco <MODEL>" line near the top of `show version`.
        const modelLine = /Model\s+(?:[Nn]umber|[Nn]ame)?\s*:?\s*([A-Za-z0-9\-+/]+)/.exec(out)?.[1]
          || /\bcisco\s+([A-Z0-9][A-Z0-9\-+/]+)\b/i.exec(out)?.[1]
          || null;
        return { vendor: "Cisco", osVersion: `IOS ${ver[1]}`, model: modelLine };
      },
    },
    {
      // Generic Linux — distro + DMI product name (works on most x86 servers,
      // returns "To be filled by O.E.M." or similar on whitebox hardware which
      // we filter out so the column shows blank rather than garbage).
      cmd: "uname -a; lsb_release -a 2>/dev/null || cat /etc/os-release 2>/dev/null; echo '---DMI---'; cat /sys/class/dmi/id/product_name 2>/dev/null",
      user: username,
      parse: (out) => {
        const distro =
          /PRETTY_NAME="?([^"\n]+)/i.exec(out)?.[1] ||
          /Description:\s*(.+)/i.exec(out)?.[1];
        const osVersion = distro?.trim()
          || (/Linux\s+\S+\s+(\S+)/.exec(out)?.[1] ?? null);
        if (!osVersion) return null;
        const dmi = out.split("---DMI---")[1]?.trim().split(/\r?\n/)[0]?.trim() || "";
        const isJunk = !dmi || /to be filled|o\.?e\.?m|system product name|default string|none/i.test(dmi);
        return { vendor: "Linux", osVersion, model: isJunk ? null : dmi };
      },
    },
  ];

  let lastErr = "";
  // Snippet of the most recent probe's actual output — surfaced in the error
  // message when nothing matches so users can see what the device sent back
  // (almost always reveals an unexpected banner, MOTD, or unparseable format).
  let lastOutputSnippet = "";
  for (const probe of probes) {
    try {
      const result = await executeSSH(r.ipAddress, port, probe.user, password, probe.cmd, {
        timeoutMs: 15_000,
        autoConfirm: true,
        enablePassword: creds.enablePassword,
        jumpHost: creds.jumpHost,
        hostKeyTrust: { routerId: r.id, expectedFingerprint: r.sshHostKeyFingerprint ?? null },
      });
      if (!result.success) {
        lastErr = result.errorMessage || "ssh failed";
        // If the SSH connection itself failed (auth/network), no point trying
        // the next probe — they'll all fail the same way. EXCEPT for the
        // MikroTik `+cte` user-suffix probes: a non-MikroTik device will
        // reject the `+cte` username with an auth error, which is the
        // expected signal to fall through to the Cisco/Linux probes below.
        const isAuthErr = /auth/i.test(lastErr);
        const isMikrotikSuffix = probe.user !== username;
        if (isAuthErr && isMikrotikSuffix) continue;
        if (/ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EHOSTUNREACH/i.test(lastErr)) break;
        if (isAuthErr) break;
        continue;
      }
      const out = result.output || "";
      lastOutputSnippet = stripAnsi(out).trim().slice(0, 300);
      const parsed = probe.parse(out);
      if (parsed) {
        await db
          .update(routersTable)
          .set({ vendor: parsed.vendor, osVersion: parsed.osVersion, model: parsed.model, lastFingerprintAt: new Date() })
          .where(eq(routersTable.id, routerId));
        return { success: true, vendor: parsed.vendor, osVersion: parsed.osVersion, model: parsed.model };
      }
    } catch (err: any) {
      lastErr = String(err?.message || err);
    }
  }
  if (!lastErr && lastOutputSnippet) {
    return {
      success: false,
      errorMessage: `No probe matched. Device responded but the output didn't match any known vendor format. First 300 chars: ${JSON.stringify(lastOutputSnippet)}`,
    };
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
