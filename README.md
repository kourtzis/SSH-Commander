# SSH Commander

A powerful, full-stack web application for managing Mikrotik routers via SSH. Designed for network administrators who need to execute commands across multiple devices simultaneously, SSH Commander provides a modern, intuitive interface for organizing routers, building reusable scripts, and running batch SSH jobs at scale.

While built with Mikrotik RouterOS devices in mind, it works with any SSH-enabled device.

---

## Key Features

### Multi-User Authentication
SSH Commander supports multiple users with role-based access control. Administrators can create and manage user accounts with two distinct roles:
- **Admin** — Full access to all features including user management
- **Operator** — Access to router management, jobs, and scripts

Sessions are managed securely with encrypted passwords and cookie-based authentication.

### Router Management
Maintain a centralized inventory of all your network devices:
- Add routers individually with name, IP address, SSH credentials, and optional description
- **Mass import** devices from `.xlsx`, `.xls`, or `.csv` files with intelligent column mapping — the importer recognizes dozens of column name variations (e.g., "hostname", "device_name", "ip", "address", "user", etc.) and provides a full data preview with row-by-row validation before importing
- **Filter & sort bar** — search by name or IP, sort by name, IP address, or date added with ascending/descending toggle
- Bulk select and delete operations for easy cleanup

### Hierarchical Device Groups
Organize devices into a flexible tree structure:
- Create nested groups and sub-groups to mirror your network topology (sites, regions, racks, VLANs, etc.)
- Add devices to groups with **multi-select** — pick one, several, or all available devices at once with checkboxes, search filtering, and "Select All / Deselect All"
- **Move groups** — relocate any group (with all its subgroups and devices) to a different parent or to root level; circular reference protection prevents invalid moves
- **Drag-and-drop** — drag groups by their handle in the left tree to reparent them, or drag sub-groups and devices from the detail pane onto any group in the tree
- **Resizable panels** — a draggable divider between the directory tree and the group detail panel; position is saved per user between sessions
- **Smart unlink** — removing a sub-group moves it one level up to its grandparent (or to root if the parent is top-level); tooltip on the unlink button shows the destination before you click
- **Circular reference protection** — both Move and Add Member endpoints use BFS descendant walks to prevent creating hierarchy loops
- A single device can belong to multiple groups
- Target entire groups (and their sub-groups) when creating batch jobs — all member devices are automatically resolved and deduplicated

### Code Snippet Library
Build and maintain a reusable library of RouterOS scripts:
- **Multi-tag system** — assign multiple tags to each snippet (e.g., "firewall", "provisioning", "vlan") with an autocomplete tag input that suggests existing tags as you type; press Enter or Tab to add tags, or click suggestions from the dropdown
- Use `{{TAG}}` syntax for variables that get substituted per-router at execution time (e.g., `{{HOSTNAME}}`, `{{VLAN_ID}}`, `{{GATEWAY}}`)
- **Modular script builder** — each snippet is composed from an ordered sequence of building blocks (references to other snippets and/or custom code blocks); add, remove, and drag-to-reorder blocks freely
- **Control character support** — insert terminal control characters (`<<CTRL+C>>`, `<<CTRL+Z>>`, `<<TAB>>`, `<<ESC>>`, etc.) anywhere in a script using the built-in "Ctrl Char" dropdown; they are sent as raw bytes to the SSH session at the exact position in the command stream
- Visual syntax highlighting for both variable tags (green) and control character tags (orange) in the snippet viewer
- **Final script preview** — a collapsible panel shows the fully assembled script from all blocks, with line count and block count summary

### Batch SSH Job Execution
The core of SSH Commander — run scripts across dozens or hundreds of routers in a single operation:
- **Concurrent execution** — up to 20 SSH sessions run in parallel for dramatically faster batch jobs on large device sets
- **"Needs Attention" mid-session** — when the auto-confirm shell encounters a prompt it doesn't recognise, the SSH session is parked instead of being closed on idle. The task flips to a `waiting_input` state, an amber panel appears on the job detail page with the captured prompt and per-device **Submit** / **Abort** controls, and the web UI plays a short attention beep. Operators can answer the prompt to let the run continue, or abort to mark the task failed. A 30-minute hard ceiling auto-aborts forgotten parked sessions. The sidebar shows a global parked-tasks badge so the cue is visible from any page.
- **Target selection** — pick individual routers and/or entire groups; drag to reorder the execution sequence
- **Modular script composition** — assemble the job's script from an arbitrary number of building blocks (snippet references and/or custom code); blocks can be inserted at any position, removed, and reordered via drag-and-drop with a visible dot-grid drag handle on each block
- **Final script preview** — a collapsible "Final Script Preview" panel lets you review the fully combined script before executing
- **Excel/CSV variable injection** — upload a spreadsheet where column headers become `{{TAG}}` names and each row maps to a router in job order, enabling fully customized per-device scripts from a single template
- **Device reachability check** — the job form shows real-time green/red SSH port reachability indicators for all target devices, auto-refreshing every 10 seconds so you know which devices are online before running
- **Detailed results** — per-router execution status (success/failed/waiting), full SSH output, connection negotiation logs, and the resolved script with all variables substituted

### Interactive SSH Mode
When the "Auto-confirm SSH prompts" toggle is turned off, jobs run in a fully interactive mode:
- All target devices connect **in parallel** via interactive shell sessions
- **Prompt detection** — automatically identifies yes/no confirmation prompts, password prompts, and general input prompts (colon-terminated lines, question marks, etc.)
- **Real-time streaming** — Server-Sent Events (SSE) push live output, status changes, and input requests to your browser instantly
- **Per-device input** — when a device hits a prompt, you can respond to one specific device, a selection of devices, or all waiting devices at once using checkboxes
- **Device grouping** — a "Group waiting" toggle sorts devices that need your input to the top of the results list for easy access
- Visual amber "Waiting for Input" panel with device checkboxes, prompt text display, and response input field

### Job Management
Full lifecycle control over your batch jobs:
- **Filter & sort bar** — search by name, filter by status (running/completed/failed/stopped/scheduled), sort by name, date, or status
- **Run Now** — re-execute any completed job with the same configuration
- **Copy** — duplicate a job configuration as a starting point for a new job
- **Edit** — update scheduled jobs in-place without recreating them
- **Stop** — halt a running job mid-execution (cleanly closes all SSH sessions)
- **Cancel** — cancel a scheduled job before it runs
- **Bulk delete** — select and remove multiple jobs at once

### Job Scheduler
Automate recurring network tasks with flexible scheduling:
- **Filter & sort bar** — search by name, filter by type (once/interval/daily/weekly/monthly) and status (active/paused), sort by name, type, or next run
- **One-time** — schedule a job to run at a specific date and time
- **Interval-based** — repeat every N minutes (e.g., every 30 minutes, every 2 hours)
- **Daily** — run at a specific time each day
- **Weekly** — run on selected days of the week at a specific time
- **Monthly** — run on a specific day of the month, or on the Nth weekday (e.g., 2nd Tuesday) at a specific time
- **Calendar view** — toggle the Scheduler page between a list and a month-grid calendar that expands every recurrence (one-time / interval / daily / weekly / monthly) into individual run cells. Click any date to see every run that day with its job and schedule name. The selected view is remembered between sessions.
- The scheduler engine checks for due jobs every 30 seconds
- One-time schedules execute the template job directly; recurring schedules clone it as new batch jobs
- Enable/disable schedules on the fly, track run counts, and view last/next execution times

### Per-Job Timeout & Automatic Retry
Make long-running batch jobs reliable on flaky links:
- **Per-job timeout** — every job has a configurable Timeout (1–3600s, default 30s) that hard-limits each device's SSH session, surfaced as a badge on the job detail page.
- **Retry on connection failure** — set Retries (0–10) and a back-off (seconds) per job. Only network and connection-level errors are retried; auth failures and post-success command errors are *never* retried, so destructive scripts cannot fire twice. Each task in the detail view shows a `Retried N×` badge when more than one attempt was used.

### Credential Profiles & Bastion Hosts
Stop pasting the same SSH credentials onto every device:
- Define a named SSH credential (username, password, optional enable/sudo password, optional jump host) once on the new `/credentials` page and attach it to any device with a dropdown. Inline username/password on the device row remain as overrides.
- **Profiles never leak secrets** — the API returns `hasPassword` / `hasEnablePassword` booleans instead of the actual values.
- **Bastion / jump host support** — a credential profile can reference another profile as a jump host. SSH (and the interactive session and per-device terminal) opens the jump connection first and `forwardOut`s to the target, so internal-only devices can be reached through a published gateway without VPN. End-to-end encrypted, two-hop.
- **Per-device enable / sudo password** — a separate `enablePassword` field (profile or inline override). When a device prompts for a `Password:` mid-session it is auto-supplied; loops are prevented by refusing to send the same value twice.
- A single shared `resolveEffectiveCreds(router)` helper centralises the resolution rules so fingerprint probes, ad-hoc batch jobs, scheduled jobs, and interactive jobs all honour profiles identically.

### Vendor / Model / OS Auto-Detection
Know what's actually on the other end of every IP:
- **Fingerprint** action per device and **Fingerprint All** bulk action probe each device with vendor-specific commands and persist `vendor`, `model`, `osVersion`, and `lastFingerprintAt`.
- **MikroTik** — RouterOS version and board name (e.g. `RB4011iGS+`, `CCR2004-1G-12S+2XS`, `hAP ax³`) fetched in a single SSH session. The probe appends the `+cte` username suffix so RouterOS sends clean output without ANSI/VT100 escape sequences.
- **Cisco** — model + IOS/NX-OS version parsed from `show version` (covers `WS-C2960-...`, `ISR4321/K9`, `C9300-24P`, etc.).
- **Linux** — distro/version from `os-release` / `uname`, plus DMI product name from `/sys/class/dmi/id/product_name` (whitebox-hardware placeholder strings like `To be filled by O.E.M.` are filtered out).
- The Devices page shows a three-line *Vendor / Model / OS* column. Search matches any of the three; the sort menu adds Vendor, Model, and OS options (un-fingerprinted devices sort to the end).
- Failed probes show the first 300 characters of what the device actually sent back, so unsupported banners can be diagnosed without server logs.

### Device Reachability & Uptime History
Continuous health visibility, no extra agents:
- A background reachability poller runs every 5 minutes and TCP-probes every device's SSH port, bulk-upserting one row per device per day in `device_reachability`.
- Devices page shows a **30-day uptime %** column with a tiny inline sparkline.
- Bulk endpoint `GET /api/routers/uptime` returns the full daily series for every device in a single round-trip (so an N-device page makes 1 request, not N).
- Per-device endpoint `GET /api/routers/:id/uptime?days=N` returns the daily history.

### Per-Device Terminal
A real persistent SSH shell, in your browser:
- Click the terminal icon on any device row to open `/routers/:id/terminal` — a server-side persistent SSH shell streamed over Server-Sent Events.
- Reuses the interactive-session machinery scoped to a single device, so it inherits jump-host routing, host-key pinning, and enable-password auto-respond.
- **Terminal access is gated by an explicit per-user grant.** Admins always have it; operators must have the new `canTerminal` flag enabled in the user editor before they can open a terminal — both the route and the UI button enforce this.
- Terminal input length is capped at 4 KiB per request to prevent a misbehaving client from flooding a server-side SSH session.

### Dry-Run / Preview Mode
See exactly what's about to run, on every device:
- The **Preview** button on the job creation page resolves all targeted devices and applies tag substitution **without executing anything**.
- A side-by-side modal shows the resolved script per device. Any unresolved `{{TAG}}` is highlighted in red so missing data is obvious before you fire.

### Job Result Export
Hand off results without screenshotting:
- **Export** menu on completed and failed jobs offers **CSV** (one row per device with status / duration / output), **TXT** (single concatenated report), and **ZIP** (one file per device output).

### Saved Views
Stop re-typing the same filters:
- Every list page can save its current search + sort + filter state under a name and recall it instantly.
- Views are scoped per user and stored in a `saved_views` table.

### Dark / Light Theme
- Sidebar toggle persists the chosen theme to localStorage and applies via `:root.light` CSS variables.
- Defaults to dark.

### Security Hardening
SSH Commander treats production deployments seriously:
- **SSH host-key TOFU pinning** — the first successful SSH connection to each device records its host-key SHA256 fingerprint. Every subsequent connection (interactive terminal, batch jobs, scheduled jobs, fingerprint probes, reachability checks via the SSH path, jump-host targets) refuses to authenticate if the device presents a different key. Admins can clear a pinned fingerprint from the device list (KeyRound icon) when a device legitimately rotates its key.
- **CSRF protection** via the `X-Requested-With: XMLHttpRequest` header pattern. Every state-changing `/api` request must carry this header; the frontend wrapper sets it automatically. Combined with the CORS allow-list, cross-site forgery of authenticated state-changing requests is blocked.
- **CORS allow-list** — production deployments require `ALLOWED_ORIGINS` (comma-separated). Unknown cross-origin browser requests are refused.
- **Mandatory `SESSION_SECRET`** in production (min 16 chars) — the app refuses to start without one when `NODE_ENV=production`.
- **Login rate limiting** — `/api/auth/login` is capped at 10 attempts per IP per 15-minute window.
- **Session regenerated on login** (defence against session-fixation).
- **PostgreSQL-backed sessions with rolling expiry** — sessions live in the database and survive API server restarts. The 7-day cookie window slides forward on every authenticated request, so an active operator is never logged out by timeout.
- **Secure cookies in production** with `TRUST_PROXY_HOPS` and `COOKIE_SECURE` env knobs for proxies that don't forward `X-Forwarded-Proto`.
- **bcrypt cost factor 12** for new and rotated user passwords.
- Body-size limits, terminal-input length caps, admin-only user-by-id reads, and `isNaN` guards on every `DELETE /:id` route.

### Control Character Injection
Scripts and snippets support inline control character tags using `<<NAME>>` syntax:
- Supported characters: `<<CTRL+A>>` through `<<CTRL+Z>>`, `<<TAB>>`, `<<ENTER>>`, `<<ESC>>`, `<<DEL>>`, `<<BACKSPACE>>`
- Both the snippet editor and job form include a convenient **Ctrl Char** dropdown button for one-click insertion
- Characters are sent as actual raw bytes to the SSH stream at the exact position where the tag appears in the script
- Useful for sending interrupt signals, navigating menus, or automating interactive CLI workflows

### UI Polish
- **Styled confirmation dialogs** — all destructive actions use a themed AlertDialog instead of native browser popups
- **Loading skeletons** — all list pages show animated skeleton placeholders while data loads
- **Empty state illustrations** — contextual icons and messages when no data exists
- **Route-level code splitting** — React.lazy + Suspense for smaller initial bundle and faster first load
- **Error boundary** — graceful fallback UI with retry button wrapping the entire app
- **Keyboard shortcuts** — Ctrl+Enter / Cmd+Enter to send responses in interactive SSH mode
- **Debounced search** — 200ms debounce on all search inputs to reduce re-renders

### Mobile Responsive
The entire interface is fully responsive and usable on tablets and phones:
- Collapsible sidebar with hamburger menu on mobile
- Tables with horizontal scrolling for narrow viewports
- Stacked layouts for forms and action buttons on small screens
- Touch-friendly controls throughout

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| **Frontend** | React 19, Vite, TailwindCSS, shadcn/ui, React Query (TanStack) |
| **Backend** | Node.js 24, Express 5, express-session |
| **Database** | PostgreSQL 16, Drizzle ORM |
| **SSH** | ssh2 with Mikrotik-compatible algorithm negotiation |
| **API** | OpenAPI 3.1 specification, Orval codegen (type-safe React Query hooks + Zod schemas) |
| **Validation** | Zod v4, drizzle-zod |
| **Auth** | bcrypt password hashing, cookie-based sessions |
| **Build** | esbuild (API server bundle), Vite (frontend) |
| **Monorepo** | pnpm workspaces, TypeScript composite project references |
| **Deployment** | Docker multi-stage build, docker-compose with PostgreSQL |

---

## Project Structure

```
ssh-commander/
├── artifacts/
│   ├── api-server/              # Express 5 API server
│   │   └── src/
│   │       ├── lib/
│   │       │   ├── auth.ts              # Session authentication & middleware
│   │       │   ├── ssh.ts               # SSH execution engine + control chars
│   │       │   ├── interactive-session.ts # Parallel interactive SSH session manager
│   │       │   ├── resolve-routers.ts   # Shared BFS group resolution + Excel helpers + concurrency limiter
│   │       │   └── scheduler.ts         # Recurring job scheduler engine
│   │       └── routes/                  # REST API route handlers
│   │           ├── auth.ts              # Login/logout/session
│   │           ├── users.ts             # User management (admin)
│   │           ├── routers.ts           # Device CRUD + mass import + reachability
│   │           ├── groups.ts            # Hierarchical group management
│   │           ├── snippets.ts          # Script snippet library
│   │           ├── jobs.ts              # Batch jobs + SSE live + interactive input
│   │           └── schedules.ts         # Job scheduling
│   └── mikro-manager/           # React + Vite frontend application
│       └── src/
│           ├── contexts/        # Auth context provider
│           ├── components/      # Reusable UI components, layout, viewers
│           └── pages/           # All application pages
│               ├── dashboard.tsx
│               ├── routers.tsx          # Device list + mass import
│               ├── groups.tsx           # Group tree + multi-select members
│               ├── snippets.tsx         # Snippet library + composer
│               ├── jobs/                # Job list, creation, detail views
│               ├── scheduler.tsx        # Schedule management
│               ├── users.tsx            # User admin
│               └── login.tsx            # Authentication
├── lib/
│   ├── api-spec/                # OpenAPI 3.1 specification + Orval config
│   ├── api-client-react/        # Auto-generated React Query hooks
│   ├── api-zod/                 # Auto-generated Zod validation schemas
│   └── db/                      # Drizzle ORM schema definitions
│       └── src/schema/
│           ├── users.ts
│           ├── routers.ts
│           ├── groups.ts
│           ├── snippets.ts
│           └── jobs.ts
├── scripts/
│   └── src/seed.ts              # Database seeding (admin user)
├── Dockerfile                   # Multi-stage production build
├── docker-compose.yml           # App + PostgreSQL orchestration
└── docker-entrypoint.sh         # Auto-migration + admin seed on startup
```

---

## Getting Started

### Prerequisites
- Node.js 24+
- pnpm 9+
- PostgreSQL 16+

### Development Setup

```bash
# Install dependencies
pnpm install

# Set up the database
export DATABASE_URL="postgresql://user:password@localhost:5432/sshcommander"
pnpm --filter @workspace/db run push
pnpm --filter @workspace/scripts run seed

# Start the API server
pnpm --filter @workspace/api-server run dev

# Start the frontend (in a separate terminal)
pnpm --filter @workspace/mikro-manager run dev
```

### Docker Installation (Recommended for Production)

Docker is the simplest way to run SSH Commander. There are two options: using Docker Compose (recommended) or running containers manually.

---

#### Option A: Docker Compose (Recommended)

This is the easiest method — one file, one command.

**Using the pre-built image from Docker Hub:**

1. Create a project folder on your server:

```bash
mkdir ssh-commander && cd ssh-commander
```

2. Create a `docker-compose.yml` file with the following contents:

```yaml
services:
  db:
    image: postgres:16-alpine
    restart: unless-stopped
    environment:
      POSTGRES_DB: mikromanager
      POSTGRES_USER: mikromanager
      POSTGRES_PASSWORD: ${DB_PASSWORD:-changeme}
    volumes:
      - pgdata:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U mikromanager"]
      interval: 5s
      timeout: 3s
      retries: 5

  app:
    image: kourtzis/ssh-commander:latest
    restart: unless-stopped
    depends_on:
      db:
        condition: service_healthy
    ports:
      - "${APP_PORT:-3000}:3000"
    environment:
      DATABASE_URL: postgresql://mikromanager:${DB_PASSWORD:-changeme}@db:5432/mikromanager
      SESSION_SECRET: ${SESSION_SECRET:-change-this-to-a-long-random-string}
      PORT: 3000
      NODE_ENV: production
      PUBLIC_DIR: /app/public

volumes:
  pgdata:
```

3. Set secure passwords and start:

```bash
export DB_PASSWORD=your-strong-database-password
export SESSION_SECRET=$(openssl rand -hex 32)
docker compose up -d
```

4. Open `http://your-server-ip:3000` in your browser.

**Building from source instead of Docker Hub:**

If you prefer to build the image yourself from the source code:

```bash
git clone <your-repo-url> ssh-commander
cd ssh-commander
docker compose up -d --build
```

Before starting, edit `docker-compose.yml` to set secure values for `POSTGRES_PASSWORD` and `SESSION_SECRET`.

This will:
1. Build the application image (multi-stage: compiles TypeScript, bundles the API server, builds the React frontend)
2. Start PostgreSQL 16 with a persistent data volume
3. Wait for the database to be healthy
4. Automatically run database migrations (Drizzle `push`)
5. Seed the default admin user (skipped if users already exist)
6. Start the application on port 3000

---

#### Option B: Manual Docker Setup (Without Docker Compose)

If you prefer to run each container individually:

1. Create a Docker network so the containers can communicate:

```bash
docker network create ssh-commander-net
```

2. Start the PostgreSQL database:

```bash
docker run -d \
  --name ssh-commander-db \
  --network ssh-commander-net \
  --restart unless-stopped \
  -e POSTGRES_DB=mikromanager \
  -e POSTGRES_USER=mikromanager \
  -e POSTGRES_PASSWORD=your-strong-db-password \
  -v ssh-commander-pgdata:/var/lib/postgresql/data \
  postgres:16-alpine
```

3. Wait a few seconds, then verify the database is ready:

```bash
docker exec ssh-commander-db pg_isready -U mikromanager
```

You should see `accepting connections`.

4. Start the application:

```bash
docker run -d \
  --name ssh-commander-app \
  --network ssh-commander-net \
  --restart unless-stopped \
  -p 3000:3000 \
  -e DATABASE_URL=postgresql://mikromanager:your-strong-db-password@ssh-commander-db:5432/mikromanager \
  -e SESSION_SECRET=$(openssl rand -hex 32) \
  -e PORT=3000 \
  -e NODE_ENV=production \
  -e PUBLIC_DIR=/app/public \
  kourtzis/ssh-commander:latest
```

5. Open `http://your-server-ip:3000` in your browser.

**Useful manual commands:**
- View app logs: `docker logs -f ssh-commander-app`
- Stop both: `docker stop ssh-commander-app ssh-commander-db`
- Remove both: `docker rm ssh-commander-app ssh-commander-db`
- Wipe database: `docker volume rm ssh-commander-pgdata`

---

#### After Installation

Open your browser and navigate to the application.

### Default Credentials

| Username | Password | Role |
|----------|----------|------|
| `admin` | `admin123` | Administrator |

> **Important:** Change the default admin password immediately after your first login via the Users page.

---

## Upgrading

SSH Commander is designed for safe, zero-data-loss upgrades. Your data lives in the PostgreSQL database which is stored in a persistent Docker volume, completely separate from the application container.

### Docker Upgrade Steps

```bash
# 1. Navigate to your SSH Commander directory
cd ssh-commander

# 2. Pull the latest code
git pull

# 3. Rebuild the application image
docker compose build --no-cache

# 4. Restart with the new version
docker compose up -d
```

On startup, the entrypoint script automatically:
- Runs database migrations to apply any new schema changes (new tables, new columns)
- Seeds the admin user only if no users exist (your existing accounts are untouched)

### Why your data is safe

- **Database volume persists** — PostgreSQL data is stored in the `pgdata` Docker volume, which survives container rebuilds and restarts. Only explicitly removing the volume (`docker compose down -v`) deletes data.
- **Migrations are additive** — Drizzle's schema push adds new tables and columns without dropping or altering existing ones. Your routers, jobs, snippets, schedules, and user accounts all remain intact.
- **Admin seed is idempotent** — The seed script checks if users exist before creating the default admin, so it never overwrites your accounts.

### Backup and Restore

For extra safety, back up your database before upgrading:

```bash
# Create a backup
docker compose exec db pg_dump -U mikromanager mikromanager > backup_$(date +%Y%m%d_%H%M%S).sql

# Restore from backup (if ever needed)
docker compose exec -i db psql -U mikromanager mikromanager < backup_YYYYMMDD_HHMMSS.sql
```

### Upgrading without Docker

If running directly on a server without Docker:

```bash
# 1. Pull the latest code
git pull

# 2. Install any new dependencies
pnpm install

# 3. Apply database schema changes
pnpm --filter @workspace/db run push

# 4. Restart the API server and frontend
# (use your process manager — systemd, pm2, etc.)
```

---

## SSH Compatibility

SSH Commander uses specifically tuned algorithm negotiation for broad device compatibility:

| Algorithm Type | Supported |
|---------------|-----------|
| **Key Exchange** | diffie-hellman-group14-sha256, diffie-hellman-group14-sha1, diffie-hellman-group1-sha1, ecdh-sha2-nistp256, ecdh-sha2-nistp521 |
| **Ciphers** | aes128-ctr, aes192-ctr, aes256-ctr, aes128-cbc, 3des-cbc |
| **Host Keys** | ssh-rsa, ecdsa-sha2-nistp256, ssh-dss |
| **HMAC** | hmac-sha2-256, hmac-sha1, hmac-md5 |

---

## API Documentation

The API follows the OpenAPI 3.1 specification located at `lib/api-spec/openapi.yaml`. Client code is auto-generated using [Orval](https://orval.dev/), producing:
- **Type-safe React Query hooks** for the frontend
- **Zod validation schemas** derived from the OpenAPI spec

To regenerate the API client after spec changes:

```bash
pnpm --filter @workspace/api-spec run codegen
```

### Key API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/auth/login` | User authentication (rate-limited: 10/IP/15min) |
| `GET` | `/api/routers` | List all routers |
| `POST` | `/api/routers/import` | Mass import routers from file data |
| `POST` | `/api/routers/:id/fingerprint` | Probe device for vendor / model / OS |
| `POST` | `/api/routers/fingerprint-all` | Bulk vendor/model/OS probe |
| `DELETE` | `/api/routers/:id/host-key` | Clear pinned SSH host-key fingerprint (re-pin on next connect) |
| `GET` | `/api/routers/uptime` | Bulk current uptime % + sparkline series for every device |
| `GET` | `/api/routers/:id/uptime?days=N` | Per-device daily uptime history |
| `GET` | `/api/routers/:id/terminal` | Per-device terminal SSE stream (gated by `canTerminal`) |
| `POST` | `/api/routers/:id/terminal/input` | Send input to per-device terminal (4 KiB cap) |
| `GET/POST` | `/api/groups` | Group management |
| `PUT` | `/api/groups/:id/move` | Move group to new parent (with circular ref protection) |
| `POST` | `/api/groups/:id/members` | Add members to group (with circular ref protection) |
| `DELETE` | `/api/groups/:id/members` | Remove member (sub-groups move one level up) |
| `GET/POST` | `/api/snippets` | Script snippet library |
| `GET/POST/PUT/DELETE` | `/api/credentials` | Credential profile CRUD (admin) |
| `POST` | `/api/jobs` | Create and run a batch job |
| `POST` | `/api/jobs/dry-run` | Resolve devices + tag substitution without executing |
| `GET` | `/api/jobs/:id/live` | SSE stream for interactive jobs |
| `POST` | `/api/jobs/:id/respond` | Send input to waiting devices |
| `GET` | `/api/jobs/:id/export?format=csv\|txt\|zip` | Export job results |
| `GET/POST` | `/api/schedules` | Job schedule management |
| `GET` | `/api/schedules/calendar?year=&month=` | Expanded run cells for calendar view |
| `GET/POST/PUT/DELETE` | `/api/saved-views` | Saved filter / sort / view state per user |

---

## Database Schema

The application uses PostgreSQL with [Drizzle ORM](https://orm.drizzle.team/). Key tables:

- **users** — Multi-user accounts with bcrypt-hashed (cost 12) passwords, admin/operator roles, and per-user `canTerminal` grant
- **routers** — Device inventory with SSH connection details (IP, port, credentials), pinned host-key fingerprint, optional `credentialProfileId`, and detected `vendor` / `model` / `osVersion` / `lastFingerprintAt`
- **credential_profiles** — Reusable named SSH credentials with optional `enablePassword` and self-referencing `jumpHostId` for bastion routing
- **router_groups** — Hierarchical group definitions with self-referencing parent
- **group_routers / group_subgroups** — Many-to-many join tables for group membership
- **snippets** — Reusable script library with categories
- **batch_jobs** — Job definitions with status tracking, target lists, execution totals, `timeoutSeconds`, `retryCount`, `retryBackoffSeconds`
- **job_tasks** — Per-router execution results with output, errors, connection logs, and `attemptCount`
- **schedules** — Job scheduling with one-time, interval, daily, weekly, and monthly recurrence types
- **device_reachability** — Per-device per-day TCP reachability rollups (`totalChecks` / `successCount`) feeding the 30-day uptime % column
- **saved_views** — Per-user saved filter / sort / view state per page (devices, jobs, scheduler)
- **session** — PostgreSQL-backed `express-session` store (managed by `connect-pg-simple`); survives API restarts

---

## Development Commands

```bash
# Install dependencies
pnpm install

# Push database schema changes
pnpm --filter @workspace/db run push

# Seed the database with admin user
pnpm --filter @workspace/scripts run seed

# Regenerate API client from OpenAPI spec
pnpm --filter @workspace/api-spec run codegen

# Start API server (development)
pnpm --filter @workspace/api-server run dev

# Start frontend (development)
pnpm --filter @workspace/mikro-manager run dev
```

---

## License

This project is proprietary software. All rights reserved.
