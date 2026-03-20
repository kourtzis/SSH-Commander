# MikroManager Workspace

## Overview

MikroManager is a full-stack web application for managing Mikrotik routers via SSH. Users can organize routers into hierarchical groups, store reusable script snippets, and run batch SSH jobs across multiple routers simultaneously. Excel/CSV-based tag substitution allows per-router variable injection in scripts.

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
│   │       ├── lib/auth.ts         # Session auth helpers
│   │       ├── lib/ssh.ts          # SSH execution + tag substitution
│   │       ├── lib/scheduler.ts     # Scheduler tick engine (30s interval)
│   │       └── routes/             # auth, users, routers, groups, snippets, jobs, schedules
│   └── mikro-manager/      # React + Vite frontend
│       └── src/
│           ├── contexts/           # auth-context.tsx (AuthProvider + useAuth)
│           ├── components/layout/  # sidebar, app-layout
│           ├── components/ui/      # shadcn UI components
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
2. **Router management** — CRUD list of Mikrotik devices with SSH credentials
3. **Hierarchical groups** — Recursive group trees (groups contain routers and/or sub-groups)
4. **Code snippets** — Named/categorized library with `{{TAG}}` placeholder support; compose new snippets from existing ones with drag-to-reorder concatenation
5. **Batch jobs** — Target individual routers and/or groups; SSH execution with per-router results; drag-to-reorder execution order for targets
6. **Multi-snippet scripts** — Add multiple snippets from the library to a job, drag to reorder, and they are concatenated sequentially; optional custom code appended after snippets
7. **Device reachability** — Real-time SSH port reachability check for all routers in the job form (green/red indicators, auto-refreshes every 10s)
8. **Excel/CSV tag substitution** — Upload .xlsx or paste CSV data; column headers become tag names, rows applied per router in job order
9. **Job scheduler** — Schedule jobs for one-time, interval-based, or weekly recurring execution; scheduler tick engine runs every 30s; one-time schedules execute the template job directly, recurring schedules clone it as new batch jobs

## TypeScript & Composite Projects

Every package extends `tsconfig.base.json` which sets `composite: true`. The root `tsconfig.json` lists all packages as project references.

## Database Schema

- `users` — id, username, email, password_hash, role (admin|operator), created_at
- `routers` — id, name, ip_address, ssh_port, ssh_username, ssh_password, description, created_at
- `router_groups` — id, name, description, parent_id, created_at
- `group_routers` — join table (group_id, router_id)
- `group_subgroups` — join table (parent_group_id, child_group_id)
- `snippets` — id, name, category, code, description, created_at, updated_at
- `batch_jobs` — id, name, script_code, status (pending|running|completed|failed|cancelled|scheduled), target_router_ids[], target_group_ids[], excel_data, totals, created_by, timestamps
- `job_tasks` — id, job_id, router_id, router_name, router_ip, status, output, error_message, timestamps
- `schedules` — id, name, job_id (template), type (once|interval|weekly), scheduled_at, interval_minutes, days_of_week[], time_of_day, next_run_at, last_run_at, enabled, run_count, created_by, created_at

## SSH Execution

The SSH engine (`lib/ssh.ts`) uses the `ssh2` package with Mikrotik-compatible algorithm lists:
- KEX: diffie-hellman-group14-sha256/sha1, ecdh-sha2-nistp256/521
- Ciphers: aes128/192/256-ctr, aes128-cbc, 3des-cbc
- Host keys: ssh-rsa, ecdsa-sha2-nistp256, ssh-dss

Tag substitution: `{{TAG_NAME}}` in script code is replaced with values from the Excel data row matching the router's position in the job.

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

## Docker

- `Dockerfile` — Multi-stage build (deps → build → production)
- `docker-compose.yml` — App + PostgreSQL with health checks
- `docker-entrypoint.sh` — Auto-runs DB migrations and seeds admin user on startup
- In production (`NODE_ENV=production`), the API server serves the frontend static files from `PUBLIC_DIR`
- Quick start: `docker compose up -d`
