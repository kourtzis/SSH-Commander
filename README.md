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
- Search and filter your device list by name or IP address
- Bulk select and delete operations for easy cleanup

### Hierarchical Router Groups
Organize routers into a flexible tree structure:
- Create nested groups and sub-groups to mirror your network topology (sites, regions, racks, VLANs, etc.)
- Add routers to groups with **multi-select** — pick one, several, or all available routers at once with checkboxes, search filtering, and "Select All / Deselect All"
- A single router can belong to multiple groups
- Target entire groups (and their sub-groups) when creating batch jobs — all member routers are automatically resolved and deduplicated

### Code Snippet Library
Build and maintain a reusable library of RouterOS scripts:
- Categorize snippets for easy organization and quick lookup
- Use `{{TAG}}` syntax for variables that get substituted per-router at execution time (e.g., `{{HOSTNAME}}`, `{{VLAN_ID}}`, `{{GATEWAY}}`)
- **Snippet Composer** — combine multiple existing snippets into new ones with drag-to-reorder concatenation
- **Control character support** — insert terminal control characters (`<<CTRL+C>>`, `<<CTRL+Z>>`, `<<TAB>>`, `<<ESC>>`, etc.) anywhere in a script using the built-in "Ctrl Char" dropdown; they are sent as raw bytes to the SSH session at the exact position in the command stream
- Visual syntax highlighting for both variable tags (green) and control character tags (orange) in the snippet viewer

### Batch SSH Job Execution
The core of SSH Commander — run scripts across dozens or hundreds of routers in a single operation:
- **Target selection** — pick individual routers and/or entire groups; drag to reorder the execution sequence
- **Multi-snippet scripts** — compose a job's script from multiple snippets in your library, drag to reorder, with optional custom code appended after the composed script
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
- **Run Now** — re-execute any completed job with the same configuration
- **Copy** — duplicate a job configuration as a starting point for a new job
- **Edit** — update scheduled jobs in-place without recreating them
- **Stop** — halt a running job mid-execution (cleanly closes all SSH sessions)
- **Cancel** — cancel a scheduled job before it runs
- **Bulk delete** — select and remove multiple jobs at once

### Job Scheduler
Automate recurring network tasks with flexible scheduling:
- **One-time** — schedule a job to run at a specific date and time
- **Interval-based** — repeat every N minutes (e.g., every 30 minutes, every 2 hours)
- **Weekly** — run on selected days of the week at a specific time
- The scheduler engine checks for due jobs every 30 seconds
- One-time schedules execute the template job directly; recurring schedules clone it as new batch jobs
- Enable/disable schedules on the fly, track run counts, and view last/next execution times

### Control Character Injection
Scripts and snippets support inline control character tags using `<<NAME>>` syntax:
- Supported characters: `<<CTRL+A>>` through `<<CTRL+Z>>`, `<<TAB>>`, `<<ENTER>>`, `<<ESC>>`, `<<DEL>>`, `<<BACKSPACE>>`
- Both the snippet editor and job form include a convenient **Ctrl Char** dropdown button for one-click insertion
- Characters are sent as actual raw bytes to the SSH stream at the exact position where the tag appears in the script
- Useful for sending interrupt signals, navigating menus, or automating interactive CLI workflows

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

### Docker Deployment

```bash
# Build and start with Docker Compose
docker compose up -d

# The app will be available at http://localhost:3000
# PostgreSQL runs alongside with persistent volume storage
```

The Docker setup handles everything automatically:
1. Multi-stage build compiles TypeScript and bundles the API server
2. Vite builds the frontend as static files
3. On startup, the entrypoint script runs database migrations and seeds the admin user
4. The API server serves both the REST API and the frontend static files

### Default Credentials

| Username | Password | Role |
|----------|----------|------|
| `admin` | `admin123` | Administrator |

> **Note:** Change the default password after first login.

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
| `POST` | `/api/auth/login` | User authentication |
| `GET` | `/api/routers` | List all routers |
| `POST` | `/api/routers/import` | Mass import routers from file data |
| `GET/POST` | `/api/groups` | Group management |
| `POST` | `/api/groups/:id/members` | Add members to group |
| `GET/POST` | `/api/snippets` | Script snippet library |
| `POST` | `/api/jobs` | Create and run a batch job |
| `GET` | `/api/jobs/:id/live` | SSE stream for interactive jobs |
| `POST` | `/api/jobs/:id/respond` | Send input to waiting devices |
| `GET/POST` | `/api/schedules` | Job schedule management |

---

## Database Schema

The application uses PostgreSQL with [Drizzle ORM](https://orm.drizzle.team/). Key tables:

- **users** — Multi-user accounts with bcrypt-hashed passwords and admin/operator roles
- **routers** — Device inventory with SSH connection details (IP, port, credentials)
- **router_groups** — Hierarchical group definitions with self-referencing parent
- **group_routers / group_subgroups** — Many-to-many join tables for group membership
- **snippets** — Reusable script library with categories
- **batch_jobs** — Job definitions with status tracking, target lists, and execution totals
- **job_tasks** — Per-router execution results with output, errors, and connection logs
- **schedules** — Job scheduling with one-time, interval, and weekly recurrence types

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
