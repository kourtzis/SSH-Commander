// ─── Per-Device Terminal Routes ─────────────────────────────────────
// SSE-based interactive SSH shell scoped to a single device. Designed for
// short, ad-hoc operator sessions ("ssh in and poke around") rather than
// long-running automation, which belongs in a Batch Job.
//
// Lifecycle:
//   GET  /routers/:id/terminal       → opens SSE stream + opens SSH shell
//   POST /routers/:id/terminal/input → forwards typed input to the shell
//
// We deliberately keep this stateless across requests by keying open
// sessions on (userId, routerId): one session per (user, device) at a time
// — connecting again replaces the previous session.

import { Router, type IRouter } from "express";
import { Client, type ClientChannel } from "ssh2";
import { db, routersTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { requireAuth } from "../lib/auth.js";

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

router.get("/routers/:id/terminal", async (req, res) => {
  requireAuth(req);
  // requireAuth() returns void in this codebase; the userId we need to scope
  // sessions lives directly on the session.
  const user = { id: (req.session as any).userId as number };
  const id = parseInt(req.params.id);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid router id" }); return; }

  const [router_] = await db.select().from(routersTable).where(eq(routersTable.id, id)).limit(1);
  if (!router_) { res.status(404).json({ error: "Router not found" }); return; }
  if (!router_.sshPassword) {
    res.status(400).json({ error: "Router has no SSH password configured" });
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

  const conn = new Client();
  const session: TerminalSession = { conn, stream: null, res, closed: false };
  sessions.set(key, session);

  const cleanup = () => {
    if (session.closed) return;
    session.closed = true;
    try { session.stream?.end(); } catch {}
    try { session.conn.end(); } catch {}
    sessions.delete(key);
    sendEvent(res, { type: "closed" });
    try { res.end(); } catch {}
  };

  req.on("close", cleanup);

  conn.on("ready", () => {
    sendEvent(res, { type: "data", data: `Connected to ${router_.name} (${router_.ipAddress})\n` });
    conn.shell({ term: "xterm-256color" }, (err, stream) => {
      if (err) {
        sendEvent(res, { type: "error", message: `shell error: ${err.message}` });
        cleanup();
        return;
      }
      session.stream = stream;
      stream.on("data", (chunk: Buffer) => {
        sendEvent(res, { type: "data", data: chunk.toString("utf8") });
      });
      stream.stderr?.on("data", (chunk: Buffer) => {
        sendEvent(res, { type: "data", data: chunk.toString("utf8") });
      });
      stream.on("close", () => {
        sendEvent(res, { type: "data", data: "\n[session closed]\n" });
        cleanup();
      });
    });
  });

  conn.on("error", (err) => {
    sendEvent(res, { type: "error", message: err.message });
    cleanup();
  });

  conn.connect({
    host: router_.ipAddress,
    port: router_.sshPort ?? 22,
    username: router_.sshUsername,
    password: router_.sshPassword,
    readyTimeout: 15_000,
  });
});

router.post("/routers/:id/terminal/input", async (req, res) => {
  requireAuth(req);
  const user = { id: (req.session as any).userId as number };
  const id = parseInt(req.params.id);
  const input = String(req.body?.input ?? "");
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

export default router;
