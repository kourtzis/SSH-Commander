// ─── Structured logger ──────────────────────────────────────────────
// App-wide pino logger. Replaces ad-hoc console.* calls so that:
//   • Every line is structured JSON in production (timestamp, level,
//     msg, plus any bound fields) — ingestible by Loki/ELK/Datadog/etc.
//   • Levels are filterable via the LOG_LEVEL env var instead of being
//     an all-or-nothing console firehose.
//
// We deliberately do NOT use a pino transport (e.g. pino-pretty) here.
// Transports run in a worker thread via thread-stream and resolve their
// target module by path at runtime, which does not survive the esbuild
// bundle step (build.ts) cleanly. Plain pino writes synchronously to fd 1
// (stdout), which bundles fine and is the correct behaviour for a
// containerised server — the orchestrator captures stdout. Operators who
// want pretty dev logs can pipe through the pino-pretty CLI:
//   pnpm --filter @workspace/api-server dev | pnpm dlx pino-pretty
//
// Default level: "info" in production, "debug" in development. Override
// with LOG_LEVEL (trace|debug|info|warn|error|fatal|silent).

import pino from "pino";

const isProd = process.env.NODE_ENV === "production";

export const logger = pino({
  level: process.env.LOG_LEVEL || (isProd ? "info" : "debug"),
  // Render the level as its name ("info") rather than its numeric code (30)
  // so raw log lines are readable without a pino-aware viewer.
  formatters: {
    level: (label) => ({ level: label }),
  },
});

// Convenience child-logger factory. Pass a component name so every line
// from that subsystem carries `{ component: "scheduler" }` for filtering.
export function childLogger(component: string) {
  return logger.child({ component });
}
