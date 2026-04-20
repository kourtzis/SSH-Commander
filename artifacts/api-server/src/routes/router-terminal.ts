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
import {
  makeHostKeyVerifier,
  SSH_ALGORITHMS,
  connectViaJumpHost,
  makeCursorResponder,
  stripAnsiStream,
  flushStripState,
  makeStripState,
  type StripState,
} from "../lib/ssh.js";
import { resolveEffectiveCreds } from "../lib/effective-creds.js";

const router: IRouter = Router();

interface TerminalSession {
  conn: Client;
  stream: ClientChannel | null;
  // Each session has exactly one SSE response writer; we replace it on reconnect.
  res: import("express").Response | null;
  closed: boolean;
}

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
  const session: TerminalSession = { conn: null as unknown as Client, stream: null, res, closed: false };
  sessions.set(key, session);

  const cleanup = () => {
    if (session.closed) return;
    session.closed = true;
    try { session.stream?.end(); } catch {}
    try { session.conn?.end(); } catch {}
    sessions.delete(key);
    sendEvent(res, { type: "closed" });
    try { res.end(); } catch {}
  };

  req.on("close", cleanup);

  // TOFU host-key verification: persist the device's host key fingerprint
  // on first connect, then refuse subsequent connections that present a
  // different key (MITM defense). Operators clear the pinned fingerprint
  // via POST /routers/:id/repin-host-key when the device legitimately
  // rotates its key.
  const hostKeyTrust = { routerId: id, expectedFingerprint: router_.sshHostKeyFingerprint ?? null };
  const hostVerifier = makeHostKeyVerifier(hostKeyTrust, (presented, expected) => {
    sendEvent(res, {
      type: "error",
      message: `Host key MISMATCH — presented ${presented}, pinned ${expected}. Refusing to connect. If the device legitimately rotated its key, an admin can re-pin from the device page.`,
    });
  });

  // Once we have a connected ssh2 Client (either direct or via bastion),
  // wire up the shell stream identically. Mirrors the per-device handler
  // in interactive-session.ts so RouterOS / Cisco quirks behave the same
  // here as in batch jobs.
  const onClientReady = (conn: Client) => {
    session.conn = conn;
    sendEvent(res, { type: "data", data: `Connected to ${router_.name} (${router_.ipAddress})\n` });
    // Explicit PTY config — same as ssh.ts/interactive-session.ts. cols=200
    // stops RouterOS from auto-wrapping, term=vt100 + the cursor responder
    // below stops devices that probe with \x1b[6n from blocking on a DSR
    // reply that would otherwise never arrive.
    conn.shell({ rows: 24, cols: 200, term: "vt100" }, (err, stream) => {
      if (err) {
        sendEvent(res, { type: "error", message: `shell error: ${err.message}` });
        cleanup();
        return;
      }
      session.stream = stream;

      // Stream-aware ANSI stripper state. SSH chunks can split a single
      // escape sequence across two TCP frames; without state, the lone
      // trailing \x1b of frame A gets dropped and `[6n` arrives in frame
      // B with nothing to anchor on, leaking visible junk to the UI. The
      // frontend renders a plain <pre>, not a real ANSI terminal, so we
      // strip ANSI here (xterm.js would do this itself, but we don't use
      // it for this lightweight terminal page).
      const stripState: StripState = makeStripState();
      // Smart DSR responder — replies to \x1b[6n with a believable cursor
      // position so RouterOS-style devices stop blocking and emit their
      // prompt. The bytes go DIRECTLY back on the SSH stream (not through
      // the user's input path), so it works even if the frontend hasn't
      // sent any keystrokes yet.
      const cursorRespond = makeCursorResponder(stream, 24, 200);

      stream.on("data", (chunk: Buffer) => {
        // Decode as binary to preserve C1 control bytes (e.g. RouterOS
        // emits the single-byte CSI 0x9B on some firmwares; utf8 mangles
        // it). The cursor responder and ANSI stripper both expect raw
        // 8-bit bytes anyway.
        const raw = chunk.toString("binary");
        cursorRespond(raw);
        const clean = stripAnsiStream(stripState, raw);
        if (clean) sendEvent(res, { type: "data", data: clean });
      });
      stream.stderr?.on("data", (chunk: Buffer) => {
        const raw = chunk.toString("binary");
        const clean = stripAnsiStream(stripState, raw);
        if (clean) sendEvent(res, { type: "data", data: clean });
      });
      stream.on("close", () => {
        // Drain any partial-escape bytes still held by the stripper so the
        // user sees the very last line of output (typically a prompt).
        const tail = flushStripState(stripState);
        if (tail) sendEvent(res, { type: "data", data: tail });
        sendEvent(res, { type: "data", data: "\n[session closed]\n" });
        cleanup();
      });
    });
  };

  // Open the SSH connection — through the jump host if a profile-attached
  // bastion was resolved, otherwise directly. Both paths use the same
  // algorithm list (SSH_ALGORITHMS) so legacy MikroTik / Cisco devices
  // negotiate successfully.
  const timeoutMs = 15_000;
  if (creds.jumpHost) {
    try {
      const conn = await connectViaJumpHost(
        { host: router_.ipAddress, port: sshPort, username: creds.username, password: creds.password, hostKeyTrust },
        creds.jumpHost,
        timeoutMs,
        [],
      );
      conn.on("error", (err) => { sendEvent(res, { type: "error", message: err.message }); cleanup(); });
      // connectViaJumpHost resolves AFTER the target is "ready", so we can
      // open the shell immediately rather than waiting for another event.
      onClientReady(conn);
    } catch (err: any) {
      sendEvent(res, { type: "error", message: String(err?.message || err) });
      cleanup();
    }
    return;
  }

  const conn = new Client();
  conn.on("ready", () => onClientReady(conn));
  conn.on("error", (err) => { sendEvent(res, { type: "error", message: err.message }); cleanup(); });
  try {
    conn.connect({
      host: router_.ipAddress,
      port: sshPort,
      username: creds.username,
      password: creds.password,
      readyTimeout: timeoutMs,
      algorithms: SSH_ALGORITHMS,
      hostVerifier,
    } as any);
  } catch (err: any) {
    sendEvent(res, { type: "error", message: String(err?.message || err) });
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
  res.json({ ok: true });
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
