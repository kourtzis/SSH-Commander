---
name: docker-deployment
description: Best practices for Dockerizing Node.js/pnpm monorepo apps. Use when creating Dockerfiles, docker-compose files, or debugging Docker build/runtime errors for any Node.js application. Also contains project-wide lessons learned covering logo generation, database optimization, frontend performance, and backend reliability patterns.
---

# Docker Deployment for Node.js / pnpm Monorepos

## Project-Wide Lessons Learned

### Logo / Asset Generation

#### AI Image Generator Limitations
- AI image generators struggle with **precise geometric control**: exact element count (3 vs 4 vs 5 chevrons), exact proportions, and progressive thickness differences.
- Prompting for "exactly three" chevrons often produced four or five; requesting "progressive thinning" yielded nearly uniform thickness.
- The `"nested/concentric"` prompt interpretation varied wildly — sometimes producing side-by-side arrows, sometimes overlapping shapes.

#### Solution: Programmatic SVG
- For precise geometric logos, **generate SVG programmatically** and convert to PNG using ImageMagick (`magick` command).
- This gives pixel-perfect control over count, spacing, stroke width, and color.
- SVG example: three `<polyline>` elements with `stroke-width` values of 70, 45, and 22 for clear progressive thinning.

#### Transparent PNG Gotchas
- Default ImageMagick `convert` produces opaque white backgrounds even with `-background none`.
- Must use `magick -background transparent` combined with `-define png:color-type=6` to force RGBA (TrueColorAlpha) output.
- Verify transparency with `magick identify -verbose` — look for `Type: PaletteAlpha` or `TrueColorAlpha` and `Channels: 4.0`.

#### Color Iteration
- Keep a backup of approved logo variants (e.g., `logo-blue.png`) for easy revert.
- Final logo: three teal (#2DD4BF) chevrons with progressive thinning, matching the app's primary accent color.

---

### Database Optimization

#### Always Add Indexes on Foreign Keys
- Drizzle ORM does not auto-create indexes on FK columns. Declare them explicitly using the third argument of `pgTable()`:
```typescript
export const jobTasksTable = pgTable("job_tasks", {
  jobId: integer("job_id").notNull(),
  // ...
}, (table) => [
  index("idx_job_tasks_job_id").on(table.jobId),
]);
```
- Critical indexes: all FK columns, `status`/enum columns used in `WHERE`, timestamp columns used in `ORDER BY` or scheduler polling (`next_run_at`).
- Use **composite indexes** for frequently combined lookups: `index("idx_job_tasks_job_router").on(table.jobId, table.routerId)`.
- Use **GIN indexes** on PostgreSQL array columns for `@>` containment queries: `index("idx_snippets_tags").using("gin", table.tags)`.

#### Query Optimization Patterns
- **Batch group resolution**: When walking hierarchical groups, use iterative BFS with `inArray()` at each depth level instead of recursive N+1 queries. Process all groups at a given depth in 2 parallel queries (router links + subgroup links).
- **Pre-pass task IDs**: When inserting tasks and immediately needing their IDs, use `.returning()` and pass the IDs forward instead of re-querying.
- **Reduce cancellation checks**: In loops processing many items, check for cancellation every Nth iteration (e.g., every 5th) instead of every iteration.
- **Consolidate UPDATEs**: Combine multiple sequential UPDATEs on the same row into a single call (e.g., setting status + resolvedScript in one update).
- **Parallelize independent queries**: Use `Promise.all()` for independent DB queries that don't depend on each other's results.
- **Column-selective queries**: Use `.select({ col1, col2 })` instead of `.select()` (SELECT *) when you only need specific columns — avoids fetching sensitive data like passwords.
- **SQL-level filtering**: Use PostgreSQL operators like `@>` for array containment instead of fetching all rows and filtering in JavaScript.

#### Dual-Table Hierarchy Sync (Group Management)
- The group hierarchy uses **two sources of truth**: `parentId` column on `router_groups` AND `group_subgroups` join table. Both must always be kept in sync.
- **All mutation endpoints** (add member, remove member, move group) must update both tables atomically in a transaction.
- **GET endpoints** should query both sources and union the results (deduplicated via `Set`) to be resilient against sync drift.
- **Circular reference protection** (BFS descendant walk) must be applied on both the Move Group endpoint AND the Add Member endpoint — not just one.
- **Unlink behavior**: removing a sub-group should move it one level up to its grandparent (not to root), preserving hierarchy context. Only moves to root when the parent is already top-level.

#### React Query Cache Invalidation
- When an operation affects multiple groups (e.g., moving a sub-group from parent A to parent B), invalidate the caches of **all affected groups**: the old parent, the new parent, and the currently selected group.
- For operations where the full set of affected groups is hard to determine (e.g., unlink moves to grandparent), use a query key predicate to invalidate all group detail queries: `qc.invalidateQueries({ predicate: (q) => (q.queryKey[0] as string).startsWith("/api/groups/") })`.
- Orval-generated query keys follow the pattern `["/api/groups/${id}"]` — use string prefix matching for broad invalidation.

#### Schema Push Safety
- Never change primary key ID column types (e.g., `serial` to `varchar`) — generates destructive `ALTER TABLE`.
- When adding columns, use `.default()` or `.notNull().default()` to avoid breaking existing rows.
- Migration from `category text` to `tags text[]`: done via raw SQL to preserve existing data.

---

### Frontend Performance (React + Vite)

#### Remove `"use client"` in Vite Projects
- shadcn/ui components ship with `"use client"` — a Next.js directive with **no meaning in Vite**.
- Causes sourcemap warnings during production builds. Safe to remove from all components.

#### React Query Defaults
- Default `staleTime` is `0`, causing aggressive refetching on mount and window focus.
- Set `staleTime: 30_000` and `refetchOnWindowFocus: false` as QueryClient defaults.

#### Route Component Stability
- Inline `<Route component={() => <Foo />} />` creates new refs each render, causing unmount/remount.
- Fix: define stable component references outside the render function.

#### Dead Code Cleanup
- Periodically audit `components/ui/` for unused shadcn components — removed 18 in one pass.
- Remove boilerplate scripts (e.g., `scripts/src/hello.ts`).

#### Hook Declaration Order — Temporal Dead Zone Trap
- `const`/`let` are hoisted but live in the TDZ until their declaration line. Any Hook (`useQuery`, `useMemo`, `useEffect`, etc.) that references a `const` declared later in the function body will compile fine and even render fine — **until** the conditional that gated the read flips truthy on a user interaction. Then it throws `ReferenceError: Cannot access 'X' before initialization` and the whole component is torn down by the error boundary.
- Real example (v1.8.18 fix):
  ```tsx
  const [expandedTask, setExpandedTask] = useState<number | null>(null);

  // ❌ References `job` before it's declared. Works while expandedTask is null
  // (short-circuits), crashes the moment the user clicks a row.
  const expandedTaskStatus = expandedTask
    ? job?.tasks?.find(t => t.id === expandedTask)?.status ?? null
    : null;
  const { data: full } = useQuery({ /* uses expandedTaskStatus */ });

  const { data: job } = useGetJob(jobId, { ... });
  ```
- Fix: place every Hook **after** every `const` it reads from. When you must keep a logical block together, leave a comment near it explaining the ordering constraint so future refactors don't undo it.
- Detection rule: any Hook body or Hook argument that names a non-state variable should sit below that variable's declaration. State setters and `useState` returns are safe (declared on their own line); query/mutation results from `useGetX(...)` are not.

#### React Query `queryKey` Stability — Don't Pass Fresh Arrays/Objects
- React Query hashes the `queryKey` to find cached data. Passing a freshly-constructed array or object on every render produces a new hash → cache miss → in-flight request gets discarded by the next render → the hook returns its default value forever (or flickers). Pages with polling, SSE, or background fetches re-render frequently and turn this from "slow" into "completely broken".
- Real example (v1.8.19 fix): `selectedRouterIds = targets.filter(...).map(...)` was rebuilt every render. Reachability polls re-rendered the page every few seconds. The unique-device counter stuck at `0` because its query was constantly invalidated before it could resolve.
- Fix: derive any list/object that ends up in a `queryKey` (or in `useEffect`/`useMemo` deps) inside `useMemo`. Sort lists when order is semantically irrelevant so `[1,2]` and `[2,1]` hash to the same key:
  ```tsx
  const ids = useMemo(
    () => targets.filter(t => t.type === "router").map(t => t.id).sort((a, b) => a - b),
    [targets],
  );
  ```
- Same rule applies to objects in `queryKey` — wrap in `useMemo` or compose the key from primitives.
- Detection rule: scan every `queryKey: [...]` and ask "is every element either a primitive or a memoized reference?" If a `.filter()`, `.map()`, `.slice()`, object literal, or `new Date()` appears inline, it's a bug.

#### Pre-Edit Checklist for React Components
Before editing any non-trivial component, walk these five lenses (added after the v1.8.18/v1.8.19 regressions):
1. **Declaration order** — does any Hook body reference a `const` declared later? If so, reorder.
2. **Reference stability** — is every value in a `queryKey`, `useEffect`/`useMemo` deps array, or `useCallback` deps array either a primitive or memoized? Inline `.filter()`/`.map()`/object literals are the usual culprits.
3. **Re-render triggers on this page** — if the page has `refetchInterval`, an `EventSource`, or background reachability/polling, treat #2 as catastrophic, not cosmetic. Test under polling, not just on first load.
4. **Call sites** — if you're changing a function or component's contract, grep every caller. Don't fix the one in front of you and ship.
5. **Backend response shape** — if you add or rename an optional field, grep every consumer in the FE and the API client codegen output.

---

### Backend Reliability

#### Input Validation & Security
- **Route param validation**: Always check `isNaN()` on parsed route params (`parseInt(req.params.id)`) before using them in queries.
- **Array input validation**: Validate array elements with `.every()` — e.g., `taskIds.every(t => Number.isInteger(t))`.
- **Input length limits**: Cap user-supplied text inputs to reasonable lengths (e.g., 4096 chars for SSH responses).
- **Array size limits**: Cap array inputs to prevent abuse (e.g., max 500 router IDs for reachability checks, max 10K rows for import).
- **Dependency auditing**: Run `npm audit` / `pnpm audit` regularly. Track remaining vulnerabilities and document why they're accepted risk (e.g., `xlsx` client-side-only usage).
- **Credential sanitization**: Always strip sensitive fields (passwords, hashes) from API responses using a `sanitize*()` helper function.

#### Background Job Error Handling
- `async` functions called without `await` (fire-and-forget) **must** have `.catch()` handlers.
- Pattern: `runJobInBackground(...).catch(err => { log; update job status to "failed" })`.

#### Batch Database Inserts
- Router import: use Drizzle's `insert().values([...])` for bulk inserts instead of one-by-one loops.
- Fallback strategy: if batch fails, retry each row individually to maximize successful inserts while reporting per-row errors.

#### Session Cookie Settings (Replit Proxy)
- Use `secure: false` and `sameSite: "lax"` — Replit's proxy handles HTTPS termination.
- `secure: true` causes cookies to be rejected in the proxied iframe context.

---

## Docker-Specific Pitfalls and Solutions

### 1. pnpm node_modules Cannot Be Copied Between Docker Stages

pnpm uses a content-addressable store with symlinks in `node_modules`. Docker `COPY` flattens symlinks, breaking module resolution for native modules (`bcrypt`, `ssh2`, `pg`, etc.).

**Wrong:**
```dockerfile
COPY --from=build /app/node_modules ./node_modules
```

**Correct:** Run a fresh `pnpm install` in the production stage:
```dockerfile
FROM base AS production
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
# Copy all workspace package.json files...
RUN pnpm install --frozen-lockfile
COPY --from=build /app/path/to/dist ./path/to/dist
```

### 2. import.meta.url Is Undefined in CJS Bundles

When esbuild bundles ESM code to CJS format (`format: "cjs"`), `import.meta.url` and `import.meta.dirname` are `undefined`. Using `fileURLToPath(import.meta.url)` will throw `ERR_INVALID_ARG_TYPE`.

**Wrong:**
```typescript
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dir = path.resolve(__dirname, "../public");
```

**Correct:** Use `process.cwd()` or `process.env` for paths:
```typescript
const dir = process.env.PUBLIC_DIR || path.resolve(process.cwd(), "public");
```

### 3. Vite Config Must Not Require Env Vars at Build Time

Vite config files that throw on missing `PORT` or other runtime env vars will crash during `docker build` since those vars don't exist at build time.

**Wrong:**
```typescript
const port = process.env.PORT;
if (!port) throw new Error("PORT required");
```

**Correct:** Provide sensible defaults for build mode:
```typescript
const isBuild = process.argv.includes("build");
const port = process.env.PORT || (isBuild ? "3000" : undefined);
if (!port) throw new Error("PORT required");
```

### 4. Replit-Specific Plugins Must Be Optional

Plugins like `@replit/vite-plugin-runtime-error-modal`, `@replit/vite-plugin-cartographer`, and `@replit/vite-plugin-dev-banner` are not available outside Replit.

**Wrong:**
```typescript
import runtimeErrorOverlay from "@replit/vite-plugin-runtime-error-modal";
plugins: [runtimeErrorOverlay()]
```

**Correct:** Use dynamic import with try/catch:
```typescript
try {
  const mod = await import("@replit/vite-plugin-runtime-error-modal");
  plugins.push(mod.default());
} catch {}
```

### 5. Shell Script Line Endings (CRLF vs LF)

Entrypoint scripts with Windows-style line endings (`\r\n`) cause `exec ./script.sh: no such file or directory` even though the file exists. The shebang line `#!/bin/sh\r` is not recognized.

**Always add this safety net in the Dockerfile:**
```dockerfile
COPY docker-entrypoint.sh ./
RUN sed -i 's/\r$//' docker-entrypoint.sh && chmod +x docker-entrypoint.sh
```

### 6. Dev Dependencies Needed at Runtime

Tools like `tsx` (TypeScript executor) are typically devDependencies but may be needed at container startup (e.g., for seed scripts or migrations that use `.ts` files). Using `pnpm install --prod` will exclude them.

**Solutions (pick one):**
- Don't use `--prod` flag — run full `pnpm install --frozen-lockfile`
- Pre-compile seed/migration scripts during the build stage
- Move runtime-critical tools to `dependencies`

### 7. Native Module Build Tools

Native modules (`bcrypt`, `ssh2`, `cpu-features`, `pg`) require build tools. Always install them:
```dockerfile
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
```

## Recommended Dockerfile Structure for pnpm Monorepos

```dockerfile
FROM node:20-slim AS base
RUN corepack enable && corepack prepare pnpm@latest --activate
WORKDIR /app

# --- Build stage: install ALL deps, compile everything ---
FROM base AS build
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.base.json ./
# Copy ALL workspace package.json files
COPY lib/*/package.json ./lib/
COPY artifacts/*/package.json ./artifacts/
COPY scripts/package.json scripts/
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
RUN pnpm install --frozen-lockfile
COPY . .
# Set build-time env vars with safe defaults
ENV PORT=3000
RUN pnpm -r run build

# --- Production stage: fresh install + built artifacts ---
FROM base AS production
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.base.json ./
# Copy ALL workspace package.json files (same as build stage)
COPY lib/*/package.json ./lib/
COPY artifacts/*/package.json ./artifacts/
COPY scripts/package.json scripts/
RUN pnpm install --frozen-lockfile
# Copy ONLY built output from build stage
COPY --from=build /app/artifacts/server/dist ./artifacts/server/dist
COPY --from=build /app/artifacts/frontend/dist ./public
COPY --from=build /app/lib ./lib
COPY --from=build /app/scripts ./scripts
COPY docker-entrypoint.sh ./
RUN sed -i 's/\r$//' docker-entrypoint.sh && chmod +x docker-entrypoint.sh

ENV NODE_ENV=production
EXPOSE 3000
ENTRYPOINT ["./docker-entrypoint.sh"]
CMD ["node", "artifacts/server/dist/index.cjs"]
```

### 8. Packages That Depend on Native Externals Must Also Be External

If a package (like `connect-pg-simple`) is in the esbuild bundle allowlist but internally `require()`s a native external (like `pg`), the resolution breaks at runtime. The bundled code can't find the native module.

**Wrong:** Bundling `connect-pg-simple` while `pg` is external:
```typescript
const allowlist = ["connect-pg-simple", ...]; // bundled
const nativeExternals = ["pg", ...]; // external
// connect-pg-simple's require('pg') fails at runtime
```

**Correct:** Move packages that depend on native externals to the externals list:
```typescript
const nativeExternals = ["connect-pg-simple", "pg", ...]; // both external
```

**Rule of thumb:** If package A depends on package B, and B is external, then A must also be external.

### 9. Express 5 Wildcard Routes Use Different Syntax

Express 5 uses a new `path-to-regexp` that rejects bare `*` wildcards. This crashes the app at startup with `TypeError: Missing parameter name at index 1: *`.

**Wrong (Express 5):**
```typescript
app.get("*", handler);
```

**Correct (Express 5):**
```typescript
app.get("/{*splat}", handler);
```

This is especially common in SPA catch-all routes that serve `index.html`. The error only surfaces in the production bundle because the catch-all route is often gated behind `NODE_ENV === "production"`.

### 10. Always Test the Production Bundle Locally Before Dockerizing

Run the built bundle with production env vars to catch runtime errors early:
```bash
PORT=3000 NODE_ENV=production PUBLIC_DIR=./public node dist/index.cjs
```

This catches issues like missing modules, broken `import.meta`, and Express 5 route syntax errors — all of which pass the build step but crash at runtime.

### 11. Production Session Store

Express's default `MemoryStore` leaks memory and doesn't survive restarts. Use a database-backed store in production:

```typescript
if (process.env.NODE_ENV === "production" && process.env.DATABASE_URL) {
  try {
    const connectPgSimple = require("connect-pg-simple");
    const PgStore = connectPgSimple(session);
    sessionConfig.store = new PgStore({
      conString: process.env.DATABASE_URL,
      createTableIfMissing: true,
    });
  } catch (err) {
    console.warn("PG session store failed, using memory store:", err);
  }
}
```

Use `require()` instead of `import` in CJS bundles and wrap in try-catch for resilience.

### 12. Docker Compose: Database Volume Gotcha

If you change `POSTGRES_PASSWORD` in `docker-compose.yml` after the database volume has been created, PostgreSQL ignores the change (it only applies on first init). Result: `password authentication failed`.

**Fix:** Remove the volume and recreate:
```bash
docker compose down -v
docker compose up -d --build
```

## Versioning & Changelog

- Version is stored in three `package.json` files: root, `artifacts/api-server`, and `artifacts/mikro-manager`. All three must be updated together.
- Follows Semantic Versioning: `MAJOR.MINOR.PATCH`
  - **PATCH** (x.y.Z): minor fixes and optimizations
  - **MINOR** (x.Y.0): substantial fixes and minor new features
  - **MAJOR** (X.0.0): major feature additions or breaking changes
  - **Pre-release**: tagged as `-b1`, `-b2`, etc. (e.g., `1.1.0-b1`) — not `-beta`
- Higher increments reset lower numbers to zero (e.g., `1.0.5` → `1.1.0`, `1.3.2` → `2.0.0`).
- All changes must be documented in `CHANGELOG.md` at the project root.
- After every substantial change, update both the version and the changelog.
- Very minor changes (e.g., small UI tweaks, documentation updates) can be appended to the current version's section in both `CHANGELOG.md` and the in-app changelog (`artifacts/mikro-manager/src/lib/version.ts`) without bumping the version number.
- **Docker Hub notification**: Every time a new version string is created, inform the user so they can tag the Docker Hub push (`kourtzis/ssh-commander:<version>`).

## Pre-Deployment Checklist

### Build Configuration
- [ ] Identify native modules in esbuild externals — they need `python3 make g++` in Docker
- [ ] Check esbuild external dependency chains — if A depends on external B, A must also be external
- [ ] Check for `import.meta.url` / `import.meta.dirname` in bundled code — use `process.cwd()` instead
- [ ] Check vite.config for hard env var requirements — add build-time defaults
- [ ] Check for Replit-specific plugin imports — wrap in dynamic import with try/catch

### Docker Setup
- [ ] Use fresh `pnpm install` in production stage — never copy `node_modules` between stages
- [ ] Install native build tools (`python3 make g++`) in both build and production stages
- [ ] Strip CRLF line endings from entrypoint scripts with `sed` safety net
- [ ] Don't use `--prod` flag if seed/migration scripts need devDependencies like `tsx`

### Runtime Validation
- [ ] **Test the production bundle locally** before Dockerizing: `PORT=3000 NODE_ENV=production node dist/index.cjs`
- [ ] Check Express version — Express 5 requires `/{*splat}` instead of `*` for catch-all routes
- [ ] Add `uncaughtException` and `unhandledRejection` handlers for clear error output
- [ ] Use database-backed session store in production (not MemoryStore)
