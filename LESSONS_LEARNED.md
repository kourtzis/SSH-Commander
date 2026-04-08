# SSH Commander — Lessons Learned

## Logo Generation

### AI Image Generator Limitations
- AI image generators struggle with **precise geometric control**: exact element count (3 vs 4 vs 5 chevrons), exact proportions, and progressive thickness differences.
- Prompting for "exactly three" chevrons often produced four or five; requesting "progressive thinning" yielded nearly uniform thickness.
- The `"nested/concentric"` prompt interpretation varied wildly — sometimes producing side-by-side arrows, sometimes overlapping shapes.

### Solution: Programmatic SVG
- For precise geometric logos, **generate SVG programmatically** and convert to PNG using ImageMagick (`magick` command).
- This gives pixel-perfect control over count, spacing, stroke width, and color.
- SVG example: three `<polyline>` elements with `stroke-width` values of 70, 45, and 22 for clear progressive thinning.

### Transparent PNG Gotchas
- Default ImageMagick `convert` produces opaque white backgrounds even with `-background none`.
- Must use `magick -background transparent` combined with `-define png:color-type=6` to force RGBA (TrueColorAlpha) output.
- Verify transparency with `magick identify -verbose` — look for `Type: PaletteAlpha` or `TrueColorAlpha` and `Channels: 4.0`.

### Color Iteration
- Started with teal (#2DD4BF), tried pale blue-gray (#94A3B8), darker steel blue (#4A7FB5), and finally settled on the app's primary teal (#2DD4BF) to match the UI accent color.
- Keep a backup of approved logo variants (e.g., `logo-blue.png`) for easy revert.

---

## Express 5 / Backend

### Catch-All Routes
- Express 5 uses `/{*splat}` syntax instead of `*` for catch-all routes. Using `*` throws errors.

### Background Job Error Handling
- `async` functions called without `await` (fire-and-forget) **must** have `.catch()` handlers attached, otherwise uncaught promise rejections can crash the Node.js process.
- Pattern: `runJobInBackground(...).catch(err => { log error; update job status to failed })`.

### Router Import — Batch Insert
- Inserting rows one-by-one in a loop is slow for large imports. Use Drizzle's `insert().values([...])` for a single bulk `INSERT`.
- Fallback strategy: if the batch insert fails (e.g., one row has a constraint violation), retry each row individually to maximize successful inserts while reporting per-row errors.

### Session Auth Cookie Settings
- In the Replit proxy environment, cookies must use `secure: false` and `sameSite: "lax"` because Replit's proxy handles HTTPS termination.
- `secure: true` causes cookies to be rejected in the proxied iframe context.

---

## Database (PostgreSQL + Drizzle ORM)

### Missing Indexes
- Drizzle schema definitions do not auto-create indexes on foreign key columns (unlike some ORMs). You must explicitly declare them.
- Critical indexes to add: all FK columns (`job_id`, `router_id`, `group_id`, etc.), status/enum columns used in `WHERE` filters, and timestamp columns used in `ORDER BY` or scheduler polling (`next_run_at`).
- Use `drizzle-kit push --force` to apply schema changes (including new indexes) without writing manual migrations.

### Schema Push Safety
- Never change primary key ID column types (e.g., `serial` to `varchar`) — this generates destructive `ALTER TABLE` statements that break existing data.
- When adding columns, use `.default()` or `.notNull().default()` to avoid breaking existing rows.
- Migration from `category text` to `tags text[]`: done via raw SQL (`ALTER TABLE ... ADD COLUMN tags text[] ... DEFAULT '{}'`, then `UPDATE snippets SET tags = ARRAY[category]`, then `ALTER TABLE ... DROP COLUMN category`).

---

## Frontend (React + Vite)

### `"use client"` Directive
- shadcn/ui components ship with `"use client"` at the top — this is a Next.js directive that has **no meaning in Vite/React**.
- It causes sourcemap warnings during production builds: `"Error when using sourcemap for reporting an error: Can't resolve original location of error."`
- Safe to remove from all components in a Vite project.

### React Query Configuration
- Default `staleTime` is `0`, causing aggressive background refetching on every component mount and window focus event.
- Set `staleTime: 30_000` and `refetchOnWindowFocus: false` as defaults to reduce unnecessary API calls.
- For actively polling views (like job detail with SSE), the explicit `refetchInterval` overrides these defaults as needed.

### Route Component Stability
- Inline arrow functions in `<Route component={() => <Foo />} />` create a **new component reference on every render**, causing React to unmount and remount the entire page tree.
- Fix: define stable component references outside the render function (e.g., `const ProtectedDashboard = () => <ProtectedRoute component={Dashboard} />`).

### Unused UI Components
- shadcn/ui's `npx shadcn-ui add` installs components individually, but over time unused ones accumulate. Periodically audit `components/ui/` and remove any not imported elsewhere in the codebase.
- Removed 18 unused components in one cleanup pass — reduces bundle size and build time.

### Excel Library (xlsx)
- The `xlsx` package is large (~1MB). It's only used on two pages (router import and job form). Consider lazy-loading via `React.lazy()` or dynamic `import()` if bundle size becomes a concern.

---

## Docker Deployment

### Build Configuration
- Native Node.js modules (`ssh2`, `bcrypt`, `pg`, `cpu-features`, `pg-native`, `connect-pg-simple`) must be listed as `nativeExternals` in the esbuild config to avoid bundling issues.
- Multi-stage Docker build: deps → build → production (keeps final image small).
- `docker-entrypoint.sh` auto-runs DB push and seeds the admin user on container start.

---

## Orval / API Codegen

### Workflow
- After any change to `lib/api-spec/openapi.yaml`, regenerate the client: `cd lib/api-spec && pnpm exec orval`.
- This updates both `lib/api-client-react/` (React Query hooks) and `lib/api-zod/` (Zod validation schemas).
- Always verify the generated types match backend route signatures after regeneration.

---

## General Patterns

### Query Keys
- React Query uses the API path as the query key (e.g., `/api/routers`, not a string like `"listRouters"`).

### Tag Substitution
- `{{TAG_NAME}}` syntax in scripts is replaced per-router using Excel data rows.
- Matching priority: `ROUTER_IP` column → `ROUTER_NAME` column → positional index fallback.

### Control Characters
- `<<CTRL+C>>`, `<<TAB>>`, `<<ENTER>>`, etc. are parsed and replaced with raw bytes by `writeCommandWithControlChars()` in `ssh.ts`.

### ScriptBlock Type
- `{ instanceId, type: "snippet"|"code", snippetId?, snippetName?, snippetTags?, code }` — the `instanceId` is a UUID for drag-and-drop identity.
