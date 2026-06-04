---
name: api-server build & test constraints
description: Non-obvious gotchas when adding deps/tests to artifacts/api-server (esbuild bundling + DB-coupled imports)
---

## @workspace/db throws at import time if DATABASE_URL is unset
Importing anything from `@workspace/db` opens a pg Pool at module load and
throws when DATABASE_URL is missing. Vitest runs without a DB, so any pure
logic you want to unit-test must NOT transitively import the db at runtime.

**How to apply:** extract pure logic into its own module that imports only
the *type* from the db (`import type { schedulesTable } from "@workspace/db"`
— erased at compile time, zero runtime coupling). Example: schedule date math
lives in `src/lib/schedule-math.ts`, re-imported by `scheduler.ts`. Tests
import the pure module directly.

## pino must be external in build.ts and configured with NO transport
The production build (`build.ts`) bundles with esbuild. pino transports
(e.g. pino-pretty) run in a worker thread via thread-stream and resolve the
target module by path at runtime, which does not survive bundling.

**How to apply:** keep `pino` and `pino-pretty` in `nativeExternals` in
`build.ts`, and configure the logger (`src/lib/logger.ts`) as plain pino
writing JSON to stdout — no `transport` option. For pretty dev logs, pipe
the dev process through the pino-pretty CLI instead of configuring a
transport. Level comes from `LOG_LEVEL` (default info in prod, debug in dev).

**Why:** a bundled transport throws "unable to determine transport target"
at runtime; plain stdout JSON is also the correct behaviour for a container
(the orchestrator captures stdout).
