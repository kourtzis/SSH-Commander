// ─── Server Entry Point ─────────────────────────────────────────────
// Boots the Express server and starts the background job scheduler.
//
// Process-level error policy:
//   The original behaviour here was "crash-fast on any uncaughtException
//   or unhandledRejection". That sounds defensible — let the container
//   orchestrator restart us into a clean state — but in practice it was
//   the direct cause of the "even one fingerprint logs me out" bug.
//   ssh2 (v1.x) throws synchronously from inside a Socket event handler
//   when a TCP connection drops before the SSH handshake completes
//   ("Connection lost before handshake"). That throw happens INSIDE a
//   net.Socket emit() — it never reaches the Client's `error` event, and
//   no amount of `conn.on("error", ...)` on our side can intercept it.
//   It lands directly on `uncaughtException`. With process.exit(1) the
//   whole API server dies, the container restarts, every in-flight
//   request returns a connection error, and the user reasonably
//   concludes they were logged out.
//
//   New policy: log the error loudly with full context, but keep the
//   process alive. If a single misbehaving SSH session can take down
//   the server for every other concurrent user, that's a far worse
//   failure mode than a leaked socket. The error originates from a
//   self-contained per-request operation; the rest of the app state
//   (express, session store, drizzle pool, scheduler) is unaffected.

process.on("uncaughtException", (err) => {
  console.error("UNCAUGHT EXCEPTION (kept alive):", err);
});

process.on("unhandledRejection", (err) => {
  console.error("UNHANDLED REJECTION (kept alive):", err);
});

import app from "./app";
import { startScheduler, stopScheduler } from "./lib/scheduler.js";
import { startReachabilityLoop } from "./lib/reachability-loop.js";
import { pool as dbPool } from "@workspace/db";

// PORT is required — set by Replit in dev, by Docker in production
const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

const server = app.listen(port, () => {
  console.log(`Server listening on port ${port}`);
  startScheduler();          // 30-second loop for scheduled jobs
  startReachabilityLoop();   // 5-minute loop for device uptime aggregates
});

// ─── Graceful shutdown ───────────────────────────────────────────────
// On SIGTERM / SIGINT (Docker stop, k8s rolling deploy, ctrl-C) drain
// in-flight HTTP requests, stop the background scheduler, and close the
// DB pool before exiting. Without this, an active job's SSH session is
// killed mid-stream, the SSE connection drops without a final event,
// and connect-pg-simple's session writes can fail with "client has
// already been closed" because the pool tore itself down before the
// in-flight responses finished.
//
// We give the server 15s to drain naturally, then exit anyway. Most
// requests are sub-second; the only ones that take longer are SSH job
// streams, which the operator can re-launch after the new container
// comes up.
let shuttingDown = false;
function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[shutdown] ${signal} received, draining (max 15s)...`);

  const forceTimer = setTimeout(() => {
    console.warn("[shutdown] Drain timeout — forcing exit.");
    process.exit(1);
  }, 15_000);
  forceTimer.unref();

  // Stop accepting new connections but let existing requests complete.
  server.close((err) => {
    if (err) console.warn("[shutdown] server.close error:", err);
    stopScheduler();
    dbPool.end()
      .catch((e) => console.warn("[shutdown] pool.end error:", e))
      .finally(() => {
        clearTimeout(forceTimer);
        console.log("[shutdown] Done.");
        process.exit(0);
      });
  });
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
