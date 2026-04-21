// ─── Per-Device Terminal Routes ─────────────────────────────────────
// SSE-based interactive SSH shell scoped to a single device. Designed for
// short, ad-hoc operator sessions ("ssh in and poke around") rather than
// long-running automation, which belongs in a Batch Job.
//
// Lifecycle:
//   GET  /routers/:id/terminal           → opens SSE stream + opens SSH shell
//   POST /routers/:id/terminal/input     → forwards typed input to the shell
//   POST /routers/:id/repin-host-key     → admin: clears the pinned host-key
//                                          fingerprint so the next connection
//                                          re-pins (used after legitimate
//                                          device key rotation)
//
// We deliberately keep this stateless across requests by keying open
// sessions on (userId, routerId): one session per (user, device) at a time
// — connecting again replaces the previous session.
//
// Authorization: terminal access is admin-only by default. Operators must
// have `canTerminal=true` set on their user record because a terminal is
// effectively a raw root shell on production gear with no per-command
// audit trail.

import { Router, type IRouter } from "express";
import { Client, type ClientChannel } from "ssh2";
import { db, routersTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { requireAuth, getCurrentUser, requireAdmin } from "../lib/auth.js";
import { connectSSH, openInteractiveShell } from "../lib/ssh.js";
import { resolveEffectiveCreds } from "../lib/effective-creds.js";
import { sshRegistry } from "../lib/ssh-registry.js";

const router: IRouter = Router();

interface TerminalSession {
  conn: Client;
  stream: ClientChannel | null;
  // Each session has exactly one SSE response writer; we replace it on reconnect.
  res: import("express").Response | null;
  closed: boolean;
  // Hygiene: we want stuck terminals to clean themselves up rather than
  // sitting forever holding an SSH socket. Two timers do that:
  //   • idleTimer  — fires after IDLE_MS of NO traffic in either direction.
  //                  Reset on every stream chunk in and every keystroke out.
  //   • globalTimer — fires after MAX_MS from session start, no matter what.
  //                  A safety ceiling so a "chatty" device that keeps the
  //                  idle timer alive can't run forever either.
  idleTimer: NodeJS.Timeout | null;
  globalTimer: NodeJS.Timeout | null;
  // Bookkeeping shown in the admin "Active Terminals" panel.
  userId: number | string;
  username: string;
  routerId: number;
  routerName: string;
  routerIp: string;
  openedAt: number;
  lastActivityAt: number;
}

// Idle ceiling: 10 minutes of complete silence in both directions closes
// the session. Long enough that a thinking operator doesn't get kicked,
// short enough that a wedged device doesn't pin a connection forever.
const IDLE_MS = 10 * 60 * 1000;
// Hard ceiling: a single terminal session can live at most 1 hour. Anything
// longer should be a Batch Job with proper auditing.
const MAX_MS = 60 * 60 * 1000;

// Keyed by `${userId}:${routerId}` so each operator has their own session
// per device, and reconnecting cleanly replaces the prior one.
const sessions = new Map<string, TerminalSession>();

function sessionKey(userId: number | string, routerId: number) {
  return `${userId}:${routerId}`;
}

function sendEvent(res: import("express").Response, event: any) {
  try { res.write(`data: ${JSON.stringify(event)}\n\n`); } catch {}
}

// Gatekeeper: admin or explicitly-granted operator. Throws 403 otherwise.
async function requireTerminalAccess(req: import("express").Request) {
  const user = await getCurrentUser(req);
  if (!user) {
    const err: any = new Error("Unauthorized"); err.status = 401; throw err;
  }
  if (user.role === "admin") return user;
  if ((user as any).canTerminal === true) return user;
  const err: any = new Error("Terminal access requires admin role or explicit grant");
  err.status = 403;
  throw err;
}

router.get("/routers/:id/terminal", async (req, res) => {
  requireAuth(req);
  const user = await requireTerminalAccess(req);
  const id = parseInt(req.params.id);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid router id" }); return; }

  const [router_] = await db.select().from(routersTable).where(eq(routersTable.id, id)).limit(1);
  if (!router_) { res.status(404).json({ error: "Router not found" }); return; }

  // Resolve effective credentials — this honours credential profiles AND
  // bastion / jump-host references. Without this, devices attached to a
  // profile (with no inline password) couldn't be reached from the
  // standalone terminal even though the same device works fine in batch
  // jobs and fingerprinting.
  const creds = await resolveEffectiveCreds(router_);
  if (!creds.password) {
    res.status(400).json({ error: "No SSH password configured (check the credential profile or set an inline password)" });
    return;
  }

  // SSE headers
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no", // disable nginx buffering for live streaming
  });
  res.flushHeaders?.();

  const key = sessionKey(user.id, id);
  // Tear down any prior session for this user+device combo so reconnects work cleanly.
  const prior = sessions.get(key);
  if (prior && !prior.closed) {
    try { prior.stream?.end(); prior.conn.end(); } catch {}
  }

  const sshPort = router_.sshPort ?? 22;
  const now = Date.now();
  const session: TerminalSession = {
    conn: null as unknown as Client,
    stream: null,
    res,
    closed: false,
    idleTimer: null,
    globalTimer: null,
    userId: user.id,
    username: (user as any).username ?? String(user.id),
    routerId: id,
    routerName: router_.name,
    routerIp: router_.ipAddress,
    openedAt: now,
    lastActivityAt: now,
  };
  sessions.set(key, session);

  const registryKey = `terminal:${user.id}:${id}`;
  const cleanup = (reason?: string) => {
    if (session.closed) return;
    session.closed = true;
    if (session.idleTimer) clearTimeout(session.idleTimer);
    if (session.globalTimer) clearTimeout(session.globalTimer);
    try { session.stream?.end(); } catch {}
    try { session.conn?.end(); } catch {}
    sessions.delete(key);
    sshRegistry.remove(registryKey);
    if (reason) sendEvent(res, { type: "data", data: `\n[${reason}]\n` });
    sendEvent(res, { type: "closed" });
    try { res.end(); } catch {}
  };

  // Reset the idle timer on every byte of activity in either direction.
  // Called from the stream-data handler AND from the input endpoint via
  // the exported markActivity() helper below.
  const resetIdleTimer = () => {
    session.lastActivityAt = Date.now();
    if (session.idleTimer) clearTimeout(session.idleTimer);
    session.idleTimer = setTimeout(() => {
      cleanup(`session idle for ${Math.round(IDLE_MS / 60000)} min — auto-closed`);
    }, IDLE_MS);
  };
  resetIdleTimer();

  // Hard ceiling — never reset.
  session.globalTimer = setTimeout(() => {
    cleanup(`session reached the ${Math.round(MAX_MS / 60000)}-minute hard limit — auto-closed`);
  }, MAX_MS);

  req.on("close", () => cleanup());

  // TOFU host-key verification: persist the device's host key fingerprint
  // on first connect, then refuse subsequent connections that present a
  // different key (MITM defense). Operators clear the pinned fingerprint
  // via POST /routers/:id/repin-host-key when the device legitimately
  // rotates its key.
  //
  // Connect (direct or via bastion) and open the standard PTY shell using
  // the shared SSHSession primitive. The primitive owns connect-and-shell
  // lifecycle (algorithm list, host-key TOFU, PTY config, cursor responder,
  // ANSI stripper) so RouterOS / Cisco quirks behave identically here, in
  // batch jobs, and in interactive sessions — fix once, applies everywhere.
  const hostKeyTrust = { routerId: id, expectedFingerprint: router_.sshHostKeyFingerprint ?? null };
  try {
    const conn = await connectSSH({
      host: router_.ipAddress,
      port: sshPort,
      username: creds.username,
      password: creds.password,
      hostKeyTrust,
      jumpHost: creds.jumpHost ?? null,
      useLegacyAlgorithms: creds.useLegacyAlgorithms,
      readyTimeoutMs: 15_000,
      onHostKeyMismatch: (presented, expected) => {
        sendEvent(res, {
          type: "error",
          message: `Host key MISMATCH — presented ${presented}, pinned ${expected}. Refusing to connect. If the device legitimately rotated its key, an admin can re-pin from the device page.`,
        });
      },
    }, {
      onError: (err) => { sendEvent(res, { type: "error", message: err.message }); cleanup(); },
    });
    // Race: req.on("close") may have fired while connectSSH was still
    // negotiating (operator hit Esc, browser closed the SSE stream, or
    // admin force-disconnected via DELETE /admin/terminals). cleanup()
    // ran with session.conn still null, so the freshly-resolved Client
    // would otherwise leak — alive on the network but with no shell to
    // pipe data through. Detect it here and tear down immediately.
    if (session.closed) {
      try { conn.end(); } catch {}
      return;
    }
    session.conn = conn;
    // Publish to the global SSH registry so the admin "Active SSH Sessions"
    // page can see this terminal alongside batch-job and interactive-job
    // connections. Removed in cleanup() above.
    sshRegistry.add({
      key: registryKey,
      kind: "terminal",
      userId: user.id,
      username: (user as any).username ?? String(user.id),
      routerId: id,
      routerName: router_.name,
      routerIp: router_.ipAddress,
      openedAt: now,
      lastActivityAt: now,
      close: () => cleanup(`disconnected by admin`),
    });
    // Also unregister if the underlying socket dies for any reason that
    // our cleanup() didn't catch (network drop, peer reset, etc.).
    conn.on("close", () => sshRegistry.remove(registryKey));
    sendEvent(res, { type: "data", data: `Connected to ${router_.name} (${router_.ipAddress})\n` });

    const shell = await openInteractiveShell(conn);
    session.stream = shell.stream;

    shell.stream.on("data", (chunk: Buffer) => {
      resetIdleTimer();
      sshRegistry.touch(registryKey);
      const clean = shell.processData(chunk, "stdout");
      if (clean) sendEvent(res, { type: "data", data: clean });
    });
    shell.stream.stderr?.on("data", (chunk: Buffer) => {
      resetIdleTimer();
      sshRegistry.touch(registryKey);
      const clean = shell.processData(chunk, "stderr");
      if (clean) sendEvent(res, { type: "data", data: clean });
    });
    shell.stream.on("close", () => {
      // Drain any partial-escape bytes still held by the stripper so the
      // user sees the very last line of output (typically a prompt).
      const tail = shell.flushTail();
      if (tail) sendEvent(res, { type: "data", data: tail });
      sendEvent(res, { type: "data", data: "\n[session closed]\n" });
      cleanup();
    });
  } catch (err: any) {
    sendEvent(res, { type: "error", message: `${err?.message || err}` });
    cleanup();
  }
});

router.post("/routers/:id/terminal/input", async (req, res) => {
  requireAuth(req);
  const user = await requireTerminalAccess(req);
  const id = parseInt(req.params.id);
  const input = String(req.body?.input ?? "");
  // Cap input size — without this, a misbehaving client can OOM the server
  // by sending a multi-megabyte string that we'd then write straight to the
  // SSH stream. 4 KiB is plenty for any interactive command line.
  if (input.length > 4096) {
    res.status(413).json({ error: "Input too large (max 4096 bytes)" });
    return;
  }
  const key = sessionKey(user.id, id);
  const session = sessions.get(key);
  if (!session || !session.stream || session.closed) {
    res.status(404).json({ error: "No active terminal session" });
    return;
  }
  // Append a newline so the remote shell treats it as a complete command.
  session.stream.write(input + "\n");
  // Reset the idle timer — operator activity counts as life signs even
  // if the device is silent on the other end.
  session.lastActivityAt = Date.now();
  sshRegistry.touch(`terminal:${user.id}:${id}`);
  if (session.idleTimer) {
    clearTimeout(session.idleTimer);
    session.idleTimer = setTimeout(() => {
      if (session.closed) return;
      session.closed = true;
      try { session.stream?.end(); } catch {}
      try { session.conn?.end(); } catch {}
      sessions.delete(key);
      const r = session.res;
      if (r) {
        try { r.write(`data: ${JSON.stringify({ type: "data", data: `\n[session idle for ${Math.round(IDLE_MS / 60000)} min — auto-closed]\n` })}\n\n`); } catch {}
        try { r.write(`data: ${JSON.stringify({ type: "closed" })}\n\n`); } catch {}
        try { r.end(); } catch {}
      }
    }, IDLE_MS);
  }
  res.json({ ok: true });
});

// ─── Admin: list & forcibly close active terminals ────────────────
// Visibility into who currently has a live shell on which device, plus
// a one-click kill switch for stuck sessions. Admin-only because this
// can disconnect another user's interactive work.
router.get("/admin/terminals", async (req, res) => {
  requireAuth(req);
  const me = await getCurrentUser(req);
  requireAdmin(me!);
  // Read from the unified SSH registry so this view covers EVERY live
  // SSH connection on the box: standalone terminals, batch jobs, and
  // interactive jobs. Sorted newest-first for triage.
  const list = sshRegistry.list();
  list.sort((a, b) => (a.openedAt < b.openedAt ? 1 : -1));
  res.json({
    sessions: list,
    idleLimitSeconds: Math.round(IDLE_MS / 1000),
    maxLifetimeSeconds: Math.round(MAX_MS / 1000),
  });
});

router.delete("/admin/terminals/:key", async (req, res) => {
  requireAuth(req);
  const me = await getCurrentUser(req);
  requireAdmin(me!);
  const key = req.params.key;
  const ok = sshRegistry.close(key, `disconnected by admin ${me!.username}`);
  if (!ok) {
    res.status(404).json({ error: "No such SSH session" });
    return;
  }
  res.json({ ok: true, message: `Closed SSH session ${key}` });
});

// Admin-only: clear the pinned host-key fingerprint so the next connection
// re-pins. Use after a legitimate device key rotation (factory reset, OS
// upgrade, etc). The next SSH connect will TOFU-pin whatever key is presented.
router.post("/routers/:id/repin-host-key", async (req, res) => {
  requireAuth(req);
  const user = await getCurrentUser(req);
  requireAdmin(user!);
  const id = parseInt(req.params.id);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid router id" }); return; }

  const [updated] = await db
    .update(routersTable)
    .set({ sshHostKeyFingerprint: null })
    .where(eq(routersTable.id, id))
    .returning({ id: routersTable.id });
  if (!updated) { res.status(404).json({ error: "Router not found" }); return; }
  res.json({ ok: true, message: "Host key fingerprint cleared. The next connection will re-pin." });
});

export default router;
