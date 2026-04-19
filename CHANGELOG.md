# Changelog

All notable changes to SSH Commander are documented in this file.

Versioning follows [Semantic Versioning](https://semver.org/):
- **MAJOR** (X.0.0) — major feature additions or breaking changes
- **MINOR** (x.Y.0) — substantial fixes and minor new features
- **PATCH** (x.y.Z) — minor fixes and optimizations
- **Pre-release** — tagged as `-b1`, `-b2`, etc. (e.g., `1.1.0-b1`)

When a higher number increments, lower numbers reset to zero (e.g., `1.0.5` → `1.1.0`).

---

## [1.8.1] - 2026-04-19

### Security
- Closed MITM gaps in 1.8.0's host-key TOFU pinning: the verifier is now wired into the jump-host target connect path (`connectViaJumpHost` in `api-server/src/lib/ssh.ts`) and into all interactive SSH job sessions (`interactive-session.ts`), so every SSH connection — direct, bastion-routed, or interactive — is pinned to the device's recorded fingerprint.
- Host-key TOFU persistence now uses a compare-and-set update (`UPDATE ... WHERE id=? AND ssh_host_key_fingerprint IS NULL`) so concurrent first-use connections cannot race in and overwrite an already-pinned fingerprint. The verifier also pins locally for the lifetime of the in-flight connection.
- Removed dead/broken host-key code in the legacy `executeSSHCommand` wrapper that referenced an out-of-scope `hostKeyTrust` variable and would have thrown at runtime if called.

### Fixed
- Per-device terminal POST input now goes through the shared API client (`customFetch`), so 1.8.0's CSRF middleware no longer rejects typed input with a 403.
- CSRF middleware exemption corrected from the non-existent `/api/health` to the actual `/api/healthz` route.

## [1.8.0] - 2026-04-19

### Security
- **SSH host-key TOFU pinning.** The first successful SSH connection to each device records its host-key SHA256 fingerprint in `routers.ssh_host_key_fingerprint`. Every subsequent connection (interactive terminal, batch jobs, scheduled jobs, vendor-fingerprint probe, reachability checks via the SSH path) refuses to authenticate if the device presents a different key — defending against MITM attacks where an attacker on-path swaps the server. Admins can clear a pinned fingerprint from the device list (KeyRound icon) when a device legitimately rotates its key (factory reset, OS upgrade, etc.).
- **Per-device terminal access is now gated by an explicit per-user grant.** Admins always have terminal access. Operators must have the new `canTerminal` flag enabled in the user editor before they can open the per-device terminal — both the route (`GET /routers/:id/terminal` and `POST /routers/:id/terminal/input`) and the UI button enforce this. The terminal is a raw root shell with no per-command audit trail, so it is no longer granted to every operator by default.
- **CSRF protection via the `X-Requested-With` header pattern.** Every state-changing `/api` request (POST/PUT/PATCH/DELETE) must carry `X-Requested-With: XMLHttpRequest`. Browsers refuse to forge this header from a cross-site form submission without a CORS preflight, and our 1.7.2 CORS allow-list rejects unknown origins on preflight — so an attacker site can no longer fire authenticated state-changing requests at the API. The frontend `customFetch` wrapper sets this header automatically on every request. Health checks and the login bootstrap step are exempt.
- **Session is regenerated on successful login** (defence against session-fixation). Any session id an attacker may have pre-set in the victim's browser via XSS on a sister subdomain or network-level injection is discarded before `userId` is attached.

### Fixed
- Light-theme audit pass: replaced hardcoded `bg-black/*` and `bg-white/*` surfaces in users page header, log panels, and tooltips so the light theme renders cleanly throughout.
- Error toasts on schedule/job pages now surface the real backend error message instead of a generic "Failed" string.

### Schema
- `routers.ssh_host_key_fingerprint` (text, nullable) — TOFU host-key pin.
- `users.can_terminal` (boolean, NOT NULL DEFAULT false) — per-user terminal grant.
- Both columns added to `docker-entrypoint.sh` defensive migrations so 1.7.x → 1.8.0 in-place container upgrades succeed even if `drizzle-kit push` fails.

---

## [1.7.2] - 2026-04-19

### Fixed
- **CRITICAL: Empty device / job lists and "Fingerprint failed: column does not exist" after upgrading from 1.4.x to 1.7.x in Docker.** The container entrypoint was running `drizzle-kit push --force || echo "warning"`, which silently swallowed migration failures and let the container start serving requests against an outdated schema. Every query that touched `routers.enable_password`, `credential_profile_id`, `vendor`, `os_version`, `last_fingerprint_at`, `batch_jobs.timeout_seconds`/`retry_count`/`retry_backoff_seconds`, or `job_tasks.attempt_count` returned HTTP 500, which the frontend renders as empty lists. The entrypoint now applies all of those columns explicitly with idempotent `ADD COLUMN IF NOT EXISTS` statements **before** running drizzle-kit push, so a broken push can no longer leave the deployment unusable.
- **Polled job-detail payload trimmed.** `GET /api/jobs/:id` no longer ships the per-task `output` and `connectionLog` blobs by default (the detail page polls every 2s); they're fetched lazily via the new `GET /api/jobs/:jobId/tasks/:taskId` endpoint when the user expands a task. The original Excel import blob is also stripped from the job response — it's never needed by the client after creation.
- **Reachability poller bulk-upserts** every device probe in a single statement instead of one INSERT per device, restoring usable performance on installs with hundreds of devices.

### Security
- **`SESSION_SECRET` is now mandatory in production** (min 16 chars). The dev fallback secret could be used to forge sessions; the app now refuses to start without a real secret when `NODE_ENV=production`.
- **CORS allow-list in production.** `ALLOWED_ORIGINS` (comma-separated) replaces the previous wide-open `cors({ origin: true, credentials: true })`. Unknown cross-origin browser requests are now refused.
- **Login rate limiting.** `/api/auth/login` is capped at 10 attempts per IP per 15-minute window.
- **Session cookies marked Secure in production** (`Set-Cookie ... Secure`).
- **Request body limit** dropped from 10mb to 1mb on general routes.
- **Terminal input length capped at 4 KiB** on `POST /routers/:id/terminal/input` so a misbehaving client can't push unbounded input into a server-side SSH session.
- **`GET /api/users/:id` is now admin-only.** Operators could previously read any user record by ID.
- **`isNaN` guards on all `DELETE /:id` routes** (routers, groups, snippets, schedules, credentials, users) — malformed IDs now return 400 instead of attempting a delete with `NaN`.
- **bcrypt cost factor raised from 10 → 12 rounds** for new and rotated user passwords.
- **Minimum password length enforced** on the credential profile form (8 chars for SSH password, 4 chars for enable password) before submission.

### Performance
- **Scheduler one-time path now executes in parallel** (10-way bounded concurrency) via a shared `executeJobTasks` helper. Previously a one-time schedule against 50 devices would block the scheduler tick for minutes — every other due schedule queued behind it.
- **Scheduler bulk-fetches** every due schedule's template job in one query (was N+1) and bulk-loads each job's tasks in one query (was one SELECT per device inside the SSH loop).
- **Scheduler router SELECT tightened** to only the columns needed for SSH execution (id, name, ip, port, username, password, enable password) — drops description, vendor, OS, timestamps from the wire.

### Frontend
- **Destructive-action confirmation** before "Run now" on a job that targets 5 or more devices.
- **Per-device terminal input** now correctly prefixes the artifact base path (was hard-coded `/api/...`, broke on path-routed deployments).

### Upgrade notes
- Set `SESSION_SECRET` in your `.env` / Docker environment before deploying. Generate one with: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`.
- Set `ALLOWED_ORIGINS=https://your-domain.example.com` (comma-separated for multiple origins) if you serve the UI from a different host than the API.

---

## [1.7.1] - 2026-04-19

### Fixed
- **Devices page slow to load in Docker / production** — the uptime sparkline rendered for every device row was firing its own `GET /routers/:id/uptime` request, so a Devices page with N devices triggered N parallel API calls (each hitting the database). The bulk endpoint `GET /routers/uptime` now returns the full daily series per device in a single round-trip, and the page consumes all sparklines from that one response. Restores pre-1.7.0 page-load speed.

---

## [1.7.0] - 2026-04-19

### Added
- **Per-job timeout** — every job has a configurable Timeout (seconds) that hard-limits each device's SSH session (1–3600s, default 30s). Surfaced as a badge on the job detail page.
- **Automatic retry on connection failure** — set Retries (0–10) and Retry back-off (seconds) on each job. Only network/connection-level errors are retried; auth failures and post-success command errors are never retried, so destructive scripts cannot fire twice. Each task on the job detail page shows a `Retried N×` badge when more than one attempt was used.
- **Device uptime tracking** — a background reachability poller runs every 5 minutes against every device's SSH port (TCP probe) and aggregates results per device per day in a new `device_reachability` table. The Devices page now has a 30-day uptime % column with a sparkline. New endpoints `GET /api/routers/uptime` (bulk current %) and `GET /api/routers/:id/uptime?days=N` (daily history).

- **Credential profiles** — define a named SSH credential (username, password, optional enable/sudo password, optional jump host) once on the new `/credentials` page and attach it to any device with a dropdown. Inline username/password on the device row remain as overrides. Profiles never expose secret values to the frontend; the API returns `hasPassword` / `hasEnablePassword` booleans instead.
- **Bastion / jump host** — credential profiles can reference another profile as a jump host. SSH (and the interactive session machinery) opens the jump connection first and `forwardOut`s to the target, so internal-only devices can be reached through a published gateway without VPN.
- **Per-device enable / sudo password** — a separate `enablePassword` field on profiles (and inline override on devices). When the device prompts for a `Password:` mid-session it is auto-supplied; loops are prevented by refusing to send the same value twice.
- **Vendor / OS auto-detection** — new `Fingerprint` action per device and `Fingerprint All` bulk action probe each device with vendor-specific commands (MikroTik `/system resource print`, Cisco `show version`, Linux `uname` / `os-release`) and persist `vendor` / `osVersion` / `lastFingerprintAt` on the router. Surfaced as a new column on the Devices page.
- **Dry-run / preview mode** — new `Preview` button on the job creation page resolves all targeted devices and applies tag substitution without executing anything. Shows the exact script that would run on each device side-by-side; any unresolved `{{TAG}}` is highlighted in red so missing data is obvious before you fire.
- **Schedule calendar view** — new `/scheduler/calendar` route shows a month grid with all scheduled runs (one-time / interval / daily / weekly / monthly recurrences expanded). Click a date to see every run that day with its job and schedule name.
- **Saved filters / views** — every list page can save its current search + sort + filter state under a name and recall it instantly. Wired on Devices page; component is reusable for Jobs and Scheduler. Views are scoped per user.
- **Job result export** — new `Export` menu on completed and failed jobs offers CSV (one row per device with status / duration / output), TXT (single concatenated report) and ZIP (one file per device output) downloads.
- **Dark / light theme toggle** — sidebar toggle persists the chosen theme to localStorage and applies via `:root.light` CSS variables. Defaults to dark.
- **Per-device terminal** — new `/routers/:id/terminal` route opens a server-side persistent SSH shell streamed over Server-Sent Events. Reuses the interactive-session machinery scoped to a single device. Reachable from the new terminal icon on every device row.

### Backend
- New `executeSSH()` wrapper in `lib/ssh.ts` consolidating timeout / retry / jump-host / enable-password options.
- New `lib/reachability-loop.ts` 5-minute poller with bounded concurrency and `ON CONFLICT` upserts.
- New tables: `credential_profiles`, `saved_views`. `routers` gained `vendor`, `osVersion`, `lastFingerprintAt`, `credentialProfileId`. `batch_jobs` schema gained `timeoutSeconds`, `retryCount`, `retryBackoffSeconds`. `job_tasks` gained `attemptCount`.
- New routes: credential profile CRUD, saved-view CRUD, fingerprint (single + bulk), dry-run, schedule calendar, job export (csv/txt/zip), per-device terminal SSE.

---

## [1.4.1] - 2026-04-19

### Added
- **Edit Schedule** — schedules can now be fully edited from the Scheduler page; change the job template, switch type (one-time / interval / daily / weekly / monthly), or adjust timing parameters and the next run is automatically recomputed

### Fixed
- **Orphan schedules on job delete** — deleting a job now also removes any schedules that reference it, so the Scheduler never shows entries pointing at a non-existent job. The job delete confirmation dialog warns you in advance how many schedules will be removed. The Scheduler page refreshes immediately after a job is deleted so cascaded schedules disappear without a manual reload.

---

## [1.4.0] - 2026-04-11

### Added
- **Styled confirmation dialogs**: all native `confirm()` popups replaced with themed AlertDialog — consistent dark-theme styling with destructive variant for delete actions
- **Loading skeleton placeholders**: all list pages (Dashboard, Devices, Groups, Jobs, Snippets, Scheduler, Users) show animated skeletons while data loads
- **Empty state illustrations**: contextual icons and messages when no data exists on every list page
- **Ctrl+Enter / Cmd+Enter shortcut**: send responses in interactive SSH job mode without clicking the button
- **Search debouncing**: 200ms debounce on all FilterSortBar search inputs to reduce re-renders during fast typing
- **Route-level code splitting**: React.lazy + Suspense for all page routes — smaller initial bundle, faster first load
- **React ErrorBoundary**: graceful fallback UI with retry button wrapping the entire app

### Improved
- **Selection highlight**: uses `bg-primary/10` for better contrast on dark backgrounds
- **Consistent page widths**: removed max-w constraint on scheduler page
- **refetchOnWindowFocus**: re-enabled for automatic data freshness when switching tabs

### Optimized
- **Concurrent SSH execution**: up to 10 parallel sessions (was sequential) — dramatically faster batch jobs on large device sets
- **Shared group resolution**: extracted `resolveRouterIds` BFS from both jobs route and scheduler into a single shared module
- **Dynamic ExcelJS import**: loaded via `import()` instead of static import — reduces initial page bundle size
- **Shared Excel helpers**: `buildExcelLookup` and `findExcelRow` consolidated into `resolve-routers` module

---

## [1.3.2] - 2025-04-11

### Added
- **Bulk device removal in Groups**: each device card now has a checkbox; a "Select All / Deselect All" toggle and a "Remove N" button appear in the Devices header — select multiple devices and remove them all with a single confirmation instead of one-by-one

---

## [1.3.1] - 2025-04-11

### Added
- **Live search in Add Members dialog**: search box now filters devices by name, IP address, and description; groups filter by name and description — list updates as you type
- **Live search in Move Group dialog**: search box to quickly find a target parent group by name or description
- **Live search in Job form target selection**: separate search boxes above the Devices and Device Groups lists, filtering by all fields as you type

### Security
- **Replaced xlsx (SheetJS) with exceljs**: eliminates 2 HIGH prototype pollution and 2 HIGH ReDoS vulnerabilities (CVE-reported, no fix from SheetJS)
- **Replaced bcrypt with bcryptjs** (pure JavaScript): eliminates moderate integer overflow / weak crypto algorithm vulnerability; also removes native compilation dependency (smaller Docker image)
- All 5 GitHub security advisories resolved — zero known vulnerabilities remaining

---

## [1.3.0] - 2025-04-11

### Added
- **Daily schedule type**: run a job every day at a specified time
- **Monthly schedule type**: supports two modes — specific day of month (e.g. on the 14th) or Nth weekday of month (e.g. 2nd Tuesday)
- **Recurring schedule category**: schedule creation now groups Interval, Daily, Weekly, and Monthly under a single "Recurring" button for a cleaner UI
- **Group counts in tree**: the left pane of the Groups page shows sub-group and device counts next to each group name (folder + number, server + number)

### Improved
- **Script builder insert bars**: horizontal insert lines and the + button are now clearly visible without hovering — increased line contrast and persistent button opacity with a subtle border
- **Text selection color**: selected text throughout the app now uses white text on a teal background instead of the previous dark-on-dark combination that made selections unreadable

---

## [1.2.2] - 2025-04-11

### Fixed
- **Sub-group detail pane**: selecting a second-level (or deeper) group now correctly shows its sub-groups in the right pane — the GET endpoint now finds children from both `parentId` and the `group_subgroups` join table (union), so even if one source is out of sync the children still appear
- **Stale right pane after operations**: move, unlink, and drag-and-drop operations now invalidate the caches of all affected groups (old parent, new parent, selected group), so the right pane updates immediately without a page refresh

---

## [1.2.1] - 2025-04-11

### Improved
- **Unlink moves one level up**: unlinking a sub-group now moves it to its grandparent instead of jumping to root level; if the parent is already at root, the child moves to root
- **Unlink tooltips**: hovering the unlink button on a sub-group shows the destination (e.g. *"Detach from this group — moves up to ParentName"* or *"…moves to root level"*); device unlink shows *"Remove device from this group"*

### Fixed
- **Circular reference protection on Add Member**: adding an ancestor group as a sub-group is now blocked with a clear error (BFS descendant walk, same as the Move endpoint)
- **Add Member dual-table sync**: adding a sub-group member now correctly sets `parentId` on the child group in addition to inserting the `group_subgroups` row
- **Unlink membership validation**: the unlink endpoint now verifies the sub-group is actually a child of the specified group before proceeding

---

## [1.2.0] - 2025-04-11

### Added
- **Resizable panel divider**: the border between the directory tree and group detail panels is now draggable to resize both panels; position is saved per user between sessions via localStorage
- **Right-pane drag-and-drop**: sub-groups and devices in the detail pane now have drag handles — drag them onto any group in the left tree to reparent (sub-groups) or add membership (devices), or drop sub-groups on the root zone to make them top-level
- Clicking a sub-group in the detail pane navigates to that group; clicking a device navigates to the Devices page

### Fixed
- **Unlink bug**: removing a sub-group member via the unlink button now correctly updates the left tree hierarchy (previously only the `group_subgroups` join table was updated, leaving the `parentId` column stale so the tree didn't reflect the change)

---

## [1.1.0] - 2025-04-10

### Added
- **Move Group feature**: relocate any group (with its subgroups and devices) to a different parent or to root level via a dedicated Move dialog with parent picker
- **Drag-and-drop group rearrangement**: grab the 6-dot handle on any group row and drop it onto another group to reparent, or onto the "Drop here to move to root level" zone; visual feedback highlights valid drop targets with a primary-color ring
- **Circular reference protection**: backend prevents moving a group under itself or any of its descendants (BFS descendant walk)
- Move button added to group detail panel (between Edit and Add buttons)
- Move dialog shows all valid target parents, filtering out the group itself and its descendants
- Separated group selection from expand/collapse — clicking a group name only selects it, the chevron arrow handles expand/contract

---

## [1.0.2] - 2025-04-10

### Added
- Version number displayed on login screen and sidebar, with clickable changelog dialog showing release history
- Changelog file (`CHANGELOG.md`) and versioning schema (SemVer with `-b` pre-release tags)
- Renamed all "Router" references to "Device" across the UI to reflect support for any SSH-enabled device

### Improved
- Added inline comments across all backend source files (routes, libraries, DB schemas, entry points) for improved readability and maintainability
- Updated skill file with database optimization patterns, query best practices, and input validation guidelines
- Updated `replit.md` with code style documentation

### Optimized
- **Batched group resolution**: `resolveRouterIds()` now uses iterative BFS with `inArray()` at each depth level instead of recursive N+1 queries — processes all groups at a given depth in 2 parallel queries (router links + subgroup links). Applied in both `jobs.ts` and `scheduler.ts`
- **Pre-passed task IDs**: `runJobInBackground()` receives pre-inserted task IDs from `.returning()`, avoiding one SELECT per device
- **Reduced cancellation checks**: Job cancellation status is now checked every 5th device instead of every iteration (80% fewer DB queries)
- **Consolidated UPDATEs**: Combined "set status to running" + "set resolvedScript" into a single UPDATE per task
- **Parallelized group detail queries**: `GET /groups/:id` runs router links and subgroup links in parallel with `Promise.all()`
- **SQL-level tag filtering**: Snippet tag filtering uses PostgreSQL's native `@>` array containment operator instead of client-side filtering
- **Column-selective queries**: Device list endpoint selects only 7 needed columns instead of `SELECT *` (avoids fetching SSH passwords)
- **New database indexes**: GIN index on `snippets.tags` for fast array containment queries; composite index on `job_tasks(job_id, router_id)` for frequent lookups

### Fixed
- **Critical bug**: `DELETE /groups/:id/members` was deleting ALL members from the group instead of just the specified one — now correctly filters by both `groupId` and `memberId`

### Security
- Reduced dependency vulnerabilities from 16 to 0 (replaced xlsx with exceljs in v1.3.1)
- Updated `drizzle-orm` 0.45.1 → 0.45.2 (HIGH: data exposure)
- Updated `vite` 7.3.1 → 7.3.2 (3 HIGH: server file access)
- Updated `picomatch` 2.3.1/4.0.3 → 2.3.2/4.0.4 (HIGH: ReDoS)
- Updated `path-to-regexp` 8.3.0 → 8.4.0 (HIGH: ReDoS)
- Updated `lodash` 4.17.23 → 4.18.0 (HIGH: prototype pollution)
- Updated `brace-expansion` 2.0.2 → 2.0.3 (moderate)
- Updated `yaml` 2.8.2 → 2.8.3 (moderate)
- Added `isNaN` checks on parsed route params
- Added integer validation on `taskIds` arrays
- Added input length limit (4096 chars) on SSH respond endpoint
- Added array size limit (500 IDs) and type validation on reachability checks
- Added import limit (10,000 devices per batch)

---

## [1.0.1] - 2025-03-15

### Added
- README deployment documentation: Docker Compose method (with pre-built Docker Hub image) and manual Docker method (container-by-container) with step-by-step guides
- Upgrading instructions with data safety explanation

---

## [1.0.0] - 2025-03-01

### Added
- Multi-user authentication with admin and operator roles
- Device management with CRUD operations and bulk import from CSV/Excel (.xlsx)
- Hierarchical device groups with nested subgroup support
- Modular code snippet library with tag-based categorization
- Batch SSH job execution across multiple devices
- Per-device variable injection via Excel/CSV with `{{TAG}}` syntax
- Interactive SSH mode with SSE live streaming and prompt detection
- Auto-confirm mode for unattended y/n prompt handling
- Control character injection in scripts (`<<CTRL+C>>`, `<<TAB>>`, etc.)
- Detailed SSH connection logging with timestamped events
- Real-time device reachability checks (TCP port probing)
- Job scheduler with one-time, interval, and weekly recurrence patterns
- Job rerun and cancellation support
- Drag-to-reorder interface elements
- Docker deployment with multi-stage build and auto-migration entrypoint
- Docker Hub image: `kourtzis/ssh-commander`
