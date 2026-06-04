---
name: Docker build pitfalls (pnpm monorepo)
description: pnpm version pinning and the non-root chown trap in the SSH Commander Dockerfile
---

The Dockerfile builds `kourtzis/ssh-commander` from a pnpm monorepo on
`node:20-slim`. Two non-obvious traps, both fixed:

**1. Pin pnpm; never `corepack prepare pnpm@latest`.**
`@latest` resolves to pnpm 11.x, which requires Node >=22.13 (it imports the
`node:sqlite` builtin) and crashes on node:20 with
"No such built-in module: node:sqlite". Pin to the version that generated
`pnpm-lock.yaml` (currently 10.26.1). Bump this pin in lockstep if the local
pnpm that regenerates the lockfile ever changes.

**2. Never `RUN chown -R node:node /app` after a pnpm install.**
**Why:** pnpm's `node_modules/.pnpm` virtual store has tens of thousands of
hardlinked files; recursing them adds minutes and looks like the build hangs on
the chown layer.
**How to apply:** chown the empty workdir once, `USER node` early, then make all
files node-owned at creation via `COPY --chown=node:node` and a node-run
`pnpm install`. Because pnpm then runs as non-root, corepack must find its cache:
set `ENV COREPACK_HOME=/opt/corepack` + `chmod -R a+rX` in the base stage so the
node user can run pnpm at build AND runtime (the entrypoint runs
`pnpm exec drizzle-kit push` / `pnpm run seed` as node).
