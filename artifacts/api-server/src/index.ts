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
import { startScheduler } from "./lib/scheduler.js";
import { startReachabilityLoop } from "./lib/reachability-loop.js";

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

app.listen(port, () => {
  console.log(`Server listening on port ${port}`);
  startScheduler();          // 30-second loop for scheduled jobs
  startReachabilityLoop();   // 5-minute loop for device uptime aggregates
});
