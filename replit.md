# SSH Commander Workspace

## Overview

SSH Commander is a full-stack web application for managing Mikrotik routers via SSH. Users can organize routers into hierarchical groups, store reusable script snippets, and run batch SSH jobs across multiple routers simultaneously. Excel/CSV-based tag substitution allows per-router variable injection in scripts.

## Stack

- **Monorepo tool**: pnpm workspaces
- **Node.js version**: 24
- **Package manager**: pnpm
- **TypeScript version**: 5.9
- **API framework**: Express 5 with express-session
- **Database**: PostgreSQL + Drizzle ORM
- **Validation**: Zod (`zod/v4`), `drizzle-zod`
- **API codegen**: Orval (from OpenAPI spec)
- **Build**: esbuild (CJS bundle)
- **Frontend**: React + Vite + TailwindCSS + shadcn/ui + React Query
- **SSH**: ssh2 with Mikrotik-compatible algorithm negotiation
- **Auth**: bcrypt password hashing + express-session (cookie)

## Default Credentials

- **Admin**: username `admin`, password `admin123`

## Structure

```text
artifacts-monorepo/
├── artifacts/
│   ├── api-server/         # Express API server
│   │   └── src/
│   │       ├── lib/auth.ts              # Session auth helpers
│   │       ├── lib/ssh.ts               # SSH execution + tag substitution
│   │       ├── lib/scheduler.ts          # Scheduler tick engine (30s interval)
│   │       ├── lib/resolve-routers.ts    # Shared BFS group resolution + Excel helpers + concurrency limiter
│   │       └── routes/                   # auth, users, routers, groups, snippets, jobs, schedules
│   └── mikro-manager/      # React + Vite frontend
│       └── src/
│           ├── contexts/           # auth-context.tsx (AuthProvider + useAuth)
│           ├── components/layout/  # sidebar, app-layout
│           ├── components/confirm-dialog.tsx  # Reusable confirm dialog (ConfirmProvider + useConfirm hook)
│           ├── components/error-boundary.tsx  # React ErrorBoundary with graceful fallback
│           ├── components/ui/      # shadcn UI components (includes alert-dialog)
│           └── pages/              # dashboard, routers, groups, snippets, jobs, scheduler, users, login
├── lib/
│   ├── api-spec/           # OpenAPI spec + Orval codegen config
│   ├── api-client-react/   # Generated React Query hooks
│   ├── api-zod/            # Generated Zod schemas from OpenAPI
│   └── db/
│       └── src/schema/     # users, routers, groups, snippets, jobs
├── scripts/
│   └── src/seed.ts         # Seeds admin user
├── pnpm-workspace.yaml
└── replit.md
```

## Features

1. **Multi-user auth** — Session-based login with admin and operator roles
2. **Router management** — CRUD list of Mikrotik devices with SSH credentials; mass import from .xlsx/.csv files with flexible column mapping and preview
3. **Hierarchical groups** — Recursive group trees (groups contain routers and/or sub-groups)
4. **Code snippets** — Multi-tag system (tags text[] in DB) with autocomplete TagInput component; `{{TAG}}` placeholder support; compose new snippets using modular script builder (ordered blocks of snippets and/or custom code)
5. **Batch jobs** — Target individual routers and/or groups; SSH execution with per-router results; drag-to-reorder execution order for targets; job actions: Run Now (rerun), Copy, Edit (scheduled only, updates in-place via PUT), Stop (running), Cancel (scheduled), bulk delete; auto-confirm SSH prompts toggle (default on); interactive mode when auto-confirm is off
6. **Modular script builder** — Shared `ScriptBuilder` component used in both job form and snippet dialog; scripts are assembled from an ordered sequence of blocks (snippet references or custom code blocks); blocks can be added at any position, removed, and reordered via drag-and-drop; each block type is expandable/collapsible; combined script preview shown when multiple blocks exist
10. **Filter/sort bars** — Reusable `FilterSortBar` component across all list views (routers, jobs, scheduler, snippets); supports text search, dropdown filters, tag filters, and column sorting with direction toggle
7. **Device reachability** — Real-time SSH port reachability check for all routers in the job form (green/red indicators, auto-refreshes every 10s)
8. **Excel/CSV tag substitution** — Upload .xlsx or paste CSV data; column headers become tag names, rows applied per router in job order
9. **Job scheduler** — Schedule jobs for one-time, or recurring execution (interval, daily, weekly, monthly); monthly supports specific day-of-month and Nth weekday modes; scheduler tick engine runs every 30s; one-time schedules execute the template job directly, recurring schedules clone it as new batch jobs

## TypeScript & Composite Projects

Every package extends `tsconfig.base.json` which sets `composite: true`. The root `tsconfig.json` lists all packages as project references.

## Database Schema

- `users` — id, username, email, password_hash, role (admin|operator), created_at
- `routers` — id, name, ip_address, ssh_port, ssh_username, ssh_password, description, created_at
- `router_groups` — id, name, description, parent_id, created_at; **indexes**: parent_id
- `group_routers` — join table (group_id, router_id); **indexes**: group_id, router_id
- `group_subgroups` — join table (parent_group_id, child_group_id); **indexes**: parent_group_id, child_group_id
- `snippets` — id, name, tags (text[]), code, description, created_at, updated_at; **indexes**: tags (GIN)
- `batch_jobs` — id, name, script_code, status (pending|running|completed|failed|cancelled|scheduled), target_router_ids[], target_group_ids[], excel_data, auto_confirm, totals, created_by, timestamps; **indexes**: status, created_by, created_at
- `job_tasks` — id, job_id, router_id, router_name, router_ip, status (pending|running|success|failed|waiting_input), output, error_message, connection_log, resolved_script, prompt_text, timestamps; **indexes**: job_id, router_id, status, (job_id, router_id) composite
- `schedules` — id, name, job_id (template), type (once|interval|daily|weekly|monthly), scheduled_at, interval_minutes, days_of_week[], time_of_day, day_of_month, monthly_mode, nth_week, nth_weekday, next_run_at, last_run_at, enabled, run_count, created_by, created_at; **indexes**: job_id, next_run_at, enabled, created_by

## SSH Execution

The SSH engine (`lib/ssh.ts`) uses the `ssh2` package with Mikrotik-compatible algorithm lists:
- KEX: diffie-hellman-group14-sha256/sha1, ecdh-sha2-nistp256/521
- Ciphers: aes128/192/256-ctr, aes128-cbc, 3des-cbc
- Host keys: ssh-rsa, ecdsa-sha2-nistp256, ssh-dss

Tag substitution: `{{TAG_NAME}}` in script code is replaced with values from the Excel data row matching the router's position in the job.

### Interactive SSH Mode

When auto-confirm is disabled on a job, SSH sessions run in interactive mode:
- All target devices connect in parallel via `conn.shell()` (interactive shell)
- Prompt detection identifies both yes/no confirmation prompts (`CONFIRM_PATTERNS`) and general input prompts (`INPUT_PATTERNS` — colon-terminated, question marks, etc.)
- When a device hits a prompt, its task status changes to `waiting_input` with the prompt text stored in `promptText`
- The backend uses SSE (Server-Sent Events) at `GET /api/jobs/:id/live` to stream real-time events: `task_status`, `task_output`, `input_required`, `input_sent`, `job_complete`
- Users can send input via `POST /api/jobs/:id/respond` with `{ taskIds: number[], input: string }` — targeting one, some, or all waiting devices
- The interactive session manager (`lib/interactive-session.ts`) keeps shell connections alive and routes user input back to specific device streams
- The job detail page shows an amber "Waiting for Input" panel with device checkboxes, prompt text, and response input field
- A "Group waiting" button sorts waiting devices to the top of the task results list
- Global timeout of 120 seconds per device; 5-second idle timer closes completed sessions

### Control Character Injection

Scripts and snippets support inline control character tags using `<<NAME>>` syntax. When the SSH engine sends a script to a device, these tags are replaced with the actual raw bytes at that exact position.

Supported tags: `<<CTRL+A>>` through `<<CTRL+Z>>`, `<<TAB>>`, `<<ENTER>>`, `<<ESC>>`, `<<DEL>>`, `<<BACKSPACE>>`. The snippet editor and job form both include a "Ctrl Char" dropdown button for easy insertion.

Implementation: `writeCommandWithControlChars()` in `ssh.ts` splits the command at `<<...>>` boundaries and writes text segments + raw control bytes sequentially to the SSH stream.

## Mobile Responsiveness

- **Sidebar**: Collapsible hamburger drawer on mobile (`md:` breakpoint); auto-closes on route change; dismissible via overlay tap, close button, or Escape key
- **Layout**: `ml-64` only on `md:` and up; mobile gets `p-4 pt-16` for hamburger button clearance
- **Page headers**: All use `flex-col sm:flex-row` to stack title/actions on small screens
- **Tables**: Wrapped in `overflow-x-auto` for horizontal scrolling on narrow viewports
- **Groups page**: Panels use `h-[400px] md:h-[600px]` for mobile-friendly heights
- **Job form**: Bottom action buttons stack vertically on mobile via `flex-col sm:flex-row`

## Running

- API server: `pnpm --filter @workspace/api-server run dev`
- Frontend: `pnpm --filter @workspace/mikro-manager run dev`
- Seed DB: `pnpm --filter @workspace/scripts run seed`
- Push schema: `pnpm --filter @workspace/db run push`
- Codegen: `pnpm --filter @workspace/api-spec run codegen`

## Versioning

- Current version: `1.8.5` (set in root `package.json`, `api-server/package.json`, `mikro-manager/package.json`, `VERSION`, `version.ts`)
- v1.8.3 fix: docker-entrypoint.sh defensive migration now CREATE TABLE IF NOT EXISTS for `credential_profiles`, `device_reachability`, `saved_views` (+ their indexes) so drizzle-kit push doesn't hit an interactive rename prompt on upgrade from older releases (the prompt was offering to rename `session` → `credential_profiles`, blocking container start). Push also runs with `</dev/null` so any future prompt fails fast instead of hanging.
- v1.8.2 perf/fix: per-request `getCurrentUser` memoization (Symbol-keyed cache on `req`); CSRF middleware mounted under `/api` instead of globally; new `TRUST_PROXY_HOPS` env var (default 1 dev / 0 prod) for correct `req.ip` behind reverse proxies; credential profile route coerces empty-string integer fields to NULL.
- v1.8.0 hardening: SSH host-key TOFU pinning (`routers.ssh_host_key_fingerprint` + `makeHostKeyVerifier` in `api-server/src/lib/ssh.ts`), per-user terminal RBAC (`users.can_terminal`), CSRF middleware in `api-server/src/app.ts` requiring `X-Requested-With` on /api non-GET routes (frontend `customFetch` sets this automatically), session regenerate on login.
- v1.8.1 follow-ups: TOFU verifier wired into jump-host target connect (`connectViaJumpHost`) and `interactive-session.ts` (was missed in 1.8.0). TOFU persistence is now compare-and-set against `IS NULL`. Per-device terminal POST input switched to `customFetch` so CSRF doesn't 403 it. CSRF exempt path corrected to `/api/healthz`.
- Follows Semantic Versioning: MAJOR.MINOR.PATCH
  - PATCH (x.y.Z): minor fixes and optimizations
  - MINOR (x.Y.0): substantial fixes and minor new features
  - MAJOR (X.0.0): major feature additions or breaking changes
  - Pre-release: tagged as `-b1`, `-b2`, etc. (e.g., `1.1.0-b1`)
- Higher increments reset lower numbers to zero (e.g., `1.0.5` → `1.1.0`)
- All changes documented in `CHANGELOG.md`

## Code Style

- All backend source files (routes, libs, DB schemas) have inline comments explaining purpose, logic, and non-obvious design decisions
- Skill file (`.agents/skills/docker-deployment/SKILL.md`) captures project-wide lessons: Docker pitfalls, DB optimization patterns, input validation, frontend performance, logo generation

## Docker

- `Dockerfile` — Multi-stage build (deps → build → production)
- `docker-compose.yml` — App + PostgreSQL with health checks
- `docker-entrypoint.sh` — Auto-runs DB migrations and seeds admin user on startup
- In production (`NODE_ENV=production`), the API server serves the frontend static files from `PUBLIC_DIR`
- Quick start: `docker compose up -d`
