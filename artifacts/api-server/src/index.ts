// ─── Server Entry Point ─────────────────────────────────────────────
// Boots the Express server and starts the background job scheduler.
// Crash-fast on uncaught errors to ensure clean restarts.

process.on("uncaughtException", (err) => {
  console.error("UNCAUGHT EXCEPTION:", err);
  process.exit(1);
});

process.on("unhandledRejection", (err) => {
  console.error("UNHANDLED REJECTION:", err);
  process.exit(1);
});

import app from "./app";
import { startScheduler } from "./lib/scheduler.js";

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
  startScheduler();  // Start the 30-second tick loop for scheduled jobs
});
