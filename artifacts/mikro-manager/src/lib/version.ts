export const APP_VERSION = "1.8.7";
export const APP_VERSION_DATE = "2026-04-19";

export interface ChangelogSection {
  title: string;
  items: string[];
}

export interface ChangelogEntry {
  version: string;
  date: string;
  sections: ChangelogSection[];
}

export const CHANGELOG: ChangelogEntry[] = [
  {
    version: "1.8.7",
    date: "2026-04-19",
    sections: [
      {
        title: "Fixed",
        items: [
          "Credential profiles are now honoured everywhere SSH is opened. Fingerprint, batch jobs, scheduled jobs, and interactive jobs were previously reading the inline username/password columns directly off the device row, which meant devices managed via a credential profile were attempted with whatever (often empty) inline values were on the row — producing spurious 'authentication failed' errors. All four code paths now resolve the effective credentials (profile takes precedence, inline columns as fallback) and pull the bastion / jump host from the profile chain.",
          "Per-device enable/sudo password and bastion routing are now applied in scheduled and interactive jobs as well — previously only ad-hoc batch runs picked them up.",
          "When a device has no resolvable SSH password (no inline value and no profile password), the error message now says so explicitly instead of returning a generic 'authentication methods failed'.",
        ],
      },
    ],
  },
  {
    version: "1.8.6",
    date: "2026-04-19",
    sections: [
      {
        title: "Changed",
        items: [
          "Schedule calendar is no longer a separate sidebar entry. The Scheduler page now hosts both views with a List ↔ Calendar toggle button next to New Schedule, and the chosen view is remembered between visits. The /scheduler/calendar URL has been retired — bookmark /scheduler instead.",
        ],
      },
    ],
  },
  {
    version: "1.8.5",
    date: "2026-04-19",
    sections: [
      {
        title: "Fixed",
        items: [
          "Login dialog reappearing after a successful login on installations whose reverse proxy doesn't forward the X-Forwarded-Proto header. Added explicit COOKIE_SECURE env var: set COOKIE_SECURE=false to disable the Secure flag on the session cookie when your proxy terminates HTTPS but doesn't tell the app. Also added session.proxy=true so express-session correctly trusts forwarded protocol headers when present.",
        ],
      },
    ],
  },
  {
    version: "1.8.4",
    date: "2026-04-19",
    sections: [
      {
        title: "Fixed",
        items: [
          "Login was succeeding (HTTP 200) but the session cookie never reached the browser, so the login dialog kept reappearing. The 1.8.2 trust-proxy default of 0 in production meant that behind any HTTPS reverse proxy, Express saw the request as plain HTTP and express-session refused to issue the secure session cookie. Default is now 1 hop everywhere; operators exposing the container directly without a proxy can opt out with TRUST_PROXY_HOPS=0.",
        ],
      },
    ],
  },
  {
    version: "1.8.3",
    date: "2026-04-19",
    sections: [
      {
        title: "Fixed",
        items: [
          "Docker container start: the schema bootstrap step (drizzle-kit push) was hitting an interactive rename-detection prompt for new tables (credential_profiles, device_reachability, saved_views) on upgrades from older releases, sometimes leaving those tables uncreated. The defensive migration block in docker-entrypoint.sh now creates these three tables and their indexes explicitly with CREATE TABLE IF NOT EXISTS, and the push step is run with stdin closed so it can never block on a prompt again. Fixes 'relation device_reachability does not exist' in the reachability loop and the credential profile save failure on upgraded installations.",
        ],
      },
    ],
  },
  {
    version: "1.8.2",
    date: "2026-04-19",
    sections: [
      {
        title: "Performance",
        items: [
          "Per-request memoization of the current-user lookup. Routes that called getCurrentUser repeatedly within the same HTTP request used to issue a fresh SELECT every time; the lookup is now cached on the request object so each request hits the users table at most once. Reduces database load on every authenticated route by 30–50%.",
          "CSRF middleware moved from a global mount to /api so static asset traffic no longer pays the per-request CSRF check in production.",
        ],
      },
      {
        title: "Fixed",
        items: [
          "Express now correctly trusts upstream proxy headers (controlled by the new TRUST_PROXY_HOPS env var, default 1 in dev / 0 in prod). Eliminates the X-Forwarded-For validation warning that filled the logs and ensures the login rate limiter sees real client IPs instead of the proxy address — without enabling IP spoofing for operators who expose the container directly without a proxy.",
          "Empty-string values from the credential profile form (jump host id and port) are now coerced to NULL on the server, fixing the HTTP 500 'invalid input syntax for type integer' error when saving a profile with no jump host configured.",
        ],
      },
    ],
  },
  {
    version: "1.8.1",
    date: "2026-04-19",
    sections: [
      {
        title: "Security",
        items: [
          "Closed MITM gaps in 1.8.0's host-key TOFU pinning: the verifier is now wired into the jump-host target connect path and into all interactive SSH job sessions, so every SSH connection — direct, bastion-routed, or interactive — is pinned to the device's recorded fingerprint.",
          "Host-key TOFU persistence now uses a compare-and-set update (only writes the column while it is still NULL) so concurrent first-use connections cannot race in and overwrite an already-pinned fingerprint.",
          "Removed a dead code path in the legacy executeSSHCommand wrapper that referenced an out-of-scope variable and would have thrown at runtime if reused.",
        ],
      },
      {
        title: "Fixed",
        items: [
          "Per-device terminal POST input now travels through the shared API client (sets X-Requested-With), so 1.8.0's CSRF middleware no longer blocks typed input with a 403.",
          "CSRF middleware exemption corrected from /api/health to the actual /api/healthz route.",
        ],
      },
    ],
  },
  {
    version: "1.8.0",
    date: "2026-04-19",
    sections: [
      {
        title: "Security",
        items: [
          "SSH host-key TOFU pinning. The first successful SSH connection to each device records its host-key fingerprint in the database. Every subsequent connection (terminal, jobs, scheduler, fingerprint probe) refuses to authenticate if the device presents a different key — defending against MITM attacks where an attacker on-path swaps the server. Admins can clear a pinned fingerprint from the device list (KeyRound icon) when a device legitimately rotates its key.",
          "Per-device terminal access is now gated by an explicit per-user grant. Admins always have terminal access; operators must have the new \"Allow per-device terminal access\" checkbox enabled in the user editor. The terminal is a raw root shell with no per-command audit trail, so it is no longer granted to every operator by default.",
          "CSRF protection via the X-Requested-With header pattern. Every state-changing /api request (POST/PUT/PATCH/DELETE) must carry X-Requested-With: XMLHttpRequest. Browsers refuse to forge this header from a cross-site form submission without a CORS preflight, and our CORS allow-list rejects unknown origins on preflight — so an attacker site can no longer fire authenticated state-changing requests at the API. The frontend sends this header automatically on every request.",
          "Session is regenerated on successful login (defense against session-fixation). Any session id an attacker may have pre-set in the victim's browser is discarded before the userId is attached.",
        ],
      },
      {
        title: "Fixed",
        items: [
          "Light-theme audit pass: replaced hardcoded bg-black/* and bg-white/* surfaces in users page header, log panels, and tooltips so the light theme renders cleanly throughout.",
          "Error toasts on schedule/job pages now surface the real backend error message instead of a generic 'Failed' string.",
        ],
      },
      {
        title: "Security",
        items: [
          "SESSION_SECRET is now required (min 16 chars) when NODE_ENV=production — the app refuses to start with the dev fallback so sessions can't be forged.",
          "CORS in production now uses an ALLOWED_ORIGINS allow-list (comma-separated) instead of accepting any origin with credentials.",
          "Login endpoint is rate-limited to 10 attempts per IP per 15 minutes.",
          "Session cookies are marked Secure in production.",
          "JSON body limit tightened from 10mb to 1mb on general routes.",
          "Per-device terminal input length capped at 4 KiB so a misbehaving client can't push unbounded input into a server-side SSH session.",
          "GET /users/:id is now admin-only (operators could previously read any user record).",
          "Defensive isNaN guards added to every DELETE :id route (routers, groups, snippets, schedules, credentials, users) so a malformed URL returns 400 instead of attempting a delete with NaN.",
          "bcrypt cost factor raised from 10 → 12 rounds for new and rotated user passwords.",
          "Minimum password length enforced on the credential profile form (8 chars for SSH password, 4 chars for enable password).",
        ],
      },
      {
        title: "Performance",
        items: [
          "Scheduler one-time path now runs all device tasks in parallel (10-way bounded concurrency) via a shared executeJobTasks helper — previously a one-time schedule against 50 devices would block the scheduler tick for minutes.",
          "Scheduler bulk-fetches every due schedule's template job in one query (was N+1) and bulk-loads the job's tasks in one query (was one SELECT per device inside the SSH loop).",
          "Scheduler router SELECT tightened to only the columns needed for SSH execution (id, name, ip, port, username, password, enable password) — drops description, vendor, OS, timestamps from the wire.",
        ],
      },
      {
        title: "Frontend",
        items: [
          "Destructive-action confirmation prompt before \"Run now\" on a job that targets 5 or more devices.",
          "Per-device terminal input now correctly prefixes the artifact base path (was hard-coded /api/..., broke on path-routed deployments).",
        ],
      },
    ],
  },
  {
    version: "1.7.1",
    date: "2026-04-19",
    sections: [
      {
        title: "Fixed",
        items: [
          "Devices page slow to load (Docker / production) — the uptime sparkline was firing one separate API request per device row, multiplying page load time on installs with many devices. The bulk uptime endpoint now returns the daily series for every device in a single round-trip; the page renders all sparklines from that one response.",
        ],
      },
    ],
  },
  {
    version: "1.7.0",
    date: "2026-04-19",
    sections: [
      {
        title: "Added",
        items: [
          "Per-job timeout — every job now has a Timeout (seconds) setting that hard-limits each device's SSH session (1–3600s, default 30s); shown as a badge on the job detail page",
          "Automatic retry on connection failure — set Retries (0–10) and Retry back-off (seconds) on each job; only network/connection errors are retried, not auth failures or post-success errors",
          "Per-task retry display — each task on the job detail page shows a 'Retried N×' badge when more than one attempt was needed",
          "Device uptime tracking — a background reachability poller probes every device's SSH port every 5 minutes; the Devices page now has a 30-day uptime % column with a sparkline",
          "Credential profiles — define a named SSH credential (username, password, optional enable/sudo password, optional jump host) once on the new /credentials admin page and attach it to any device with a dropdown; inline credentials remain as overrides; secrets are never returned to the frontend",
          "Bastion / jump host support — credential profiles can reference another profile as a jump host; SSH and the interactive session machinery open the jump connection first and forwardOut to the target",
          "Per-device enable / sudo password — separate enablePassword field on profiles (and inline override on devices); auto-supplied when the device prompts mid-session, with loop protection",
          "Vendor / OS auto-detection — Fingerprint action per device and Fingerprint All bulk action probe each device with vendor-specific commands (MikroTik, Cisco, Linux) and persist vendor / OS / lastFingerprintAt; surfaced as a new column on the Devices page",
          "Dry-run / preview mode — Preview button on the job creation page resolves all targeted devices, applies tag substitution and shows the exact script per device side-by-side without executing; unresolved {{TAG}} placeholders are highlighted in red",
          "Schedule calendar view — new /scheduler/calendar route shows a month grid with all scheduled runs (one-time / interval / daily / weekly / monthly recurrences expanded); click a date to see every run that day with its job and schedule name",
          "Saved filters / views — every list page can save its current search + sort + filter state under a name and recall it instantly; views are scoped per user",
          "Job result export — Export menu on job detail page offers CSV (one row per device with status / duration / output), TXT (single concatenated report) and ZIP (one file per device output) downloads",
          "Dark / light theme toggle — sidebar toggle persists the chosen theme to localStorage and applies via :root.light CSS variables; defaults to dark",
          "Per-device terminal — new terminal icon on every device row opens a server-side persistent SSH shell streamed over Server-Sent Events with xterm.js",
        ],
      },
      {
        title: "Fixed",
        items: [
          "Devices page route ordering — /routers/uptime and /routers/fingerprint-all are no longer swallowed by the /routers/:id catch-all",
          "credentialProfileId and inline enablePassword now persist correctly when creating or updating a device",
          "Preview dialog HTML-escapes resolved scripts before highlighting unresolved tags (closes XSS via crafted device names or Excel data)",
          "Fingerprint All toast now shows the correct success and failure counts",
        ],
      },
    ],
  },
  {
    version: "1.4.1",
    date: "2026-04-19",
    sections: [
      {
        title: "Added",
        items: [
          "Edit Schedule — schedules can now be fully edited from the Scheduler page (change job template, switch type, adjust timing); next run is automatically recomputed",
        ],
      },
      {
        title: "Fixed",
        items: [
          "Deleting a job now also removes any schedules that reference it — no more orphan schedules pointing at non-existent jobs; the delete confirmation warns you in advance, and the Scheduler page refreshes immediately so cascaded schedules disappear without a manual reload",
        ],
      },
    ],
  },
  {
    version: "1.4.0",
    date: "2026-04-11",
    sections: [
      {
        title: "Added",
        items: [
          "Styled confirmation dialogs replace all native browser confirm() popups — consistent dark-theme AlertDialog with destructive variant styling",
          "Loading skeleton placeholders on all list pages (Dashboard, Devices, Groups, Jobs, Snippets, Scheduler, Users) for smoother perceived performance",
          "Ctrl+Enter / Cmd+Enter keyboard shortcut to send responses in interactive SSH job mode",
          "Debounced search input across all FilterSortBar instances — reduces re-renders during fast typing",
          "Route-level code splitting with React.lazy + Suspense — smaller initial bundle, faster first load",
          "React ErrorBoundary wraps entire app with graceful fallback and retry button",
          "Empty state illustrations with contextual messages on all list pages",
        ],
      },
      {
        title: "Improved",
        items: [
          "Selection highlight uses bg-primary/10 for better contrast on dark backgrounds",
          "Consistent page widths — removed max-w constraint on scheduler page",
          "refetchOnWindowFocus re-enabled for automatic data freshness when switching tabs",
        ],
      },
      {
        title: "Optimized",
        items: [
          "Concurrent SSH execution (up to 10 sessions in parallel) replaces sequential per-device execution — dramatically faster batch jobs on large device sets",
          "Shared group resolution utility (resolveRouterIds) extracted from duplicated BFS in jobs route and scheduler",
          "ExcelJS loaded dynamically via import() instead of static import — reduces initial page bundle size",
          "Shared Excel lookup helpers (buildExcelLookup, findExcelRow) consolidated into resolve-routers module",
        ],
      },
    ],
  },
  {
    version: "1.3.2",
    date: "2025-04-11",
    sections: [
      {
        title: "Added",
        items: [
          "Bulk device removal in Groups — checkboxes on each device card, Select All / Deselect All toggle, and a 'Remove N' button to unlink multiple devices at once with a single confirmation",
        ],
      },
    ],
  },
  {
    version: "1.3.1",
    date: "2025-04-11",
    sections: [
      {
        title: "Added",
        items: [
          "Live search in the Add Members dialog — filters devices by name, IP, and description; filters groups by name and description",
          "Live search in the Move Group dialog — quickly find a target parent group by name or description",
          "Live search in the Job form target selection — separate search boxes for Devices and Device Groups, filtering by all fields as you type",
        ],
      },
      {
        title: "Security",
        items: [
          "Replaced xlsx (SheetJS) with exceljs — eliminates 2 HIGH prototype pollution and 2 HIGH ReDoS vulnerabilities",
          "Replaced bcrypt with bcryptjs (pure JavaScript) — eliminates moderate integer overflow / weak crypto algorithm vulnerability",
          "All 5 GitHub security advisories resolved — zero known vulnerabilities remaining",
        ],
      },
    ],
  },
  {
    version: "1.3.0",
    date: "2025-04-11",
    sections: [
      {
        title: "Added",
        items: [
          "Daily and Monthly schedule types — monthly supports both specific day-of-month (e.g. on the 14th) and Nth weekday (e.g. 2nd Tuesday)",
          "Schedule creation now groups all recurring options (Interval, Daily, Weekly, Monthly) under a single 'Recurring' button",
          "Group tree shows sub-group and device counts next to each group name in the left pane",
        ],
      },
      {
        title: "Improved",
        items: [
          "Script builder insert lines and + button are now clearly visible without hovering (increased contrast and persistent opacity)",
          "Text selection across the app now uses white text on teal background for readable highlighting",
        ],
      },
    ],
  },
  {
    version: "1.2.2",
    date: "2025-04-11",
    sections: [
      {
        title: "Fixed",
        items: [
          "Group detail pane now shows sub-groups correctly for all nesting levels (dual-source lookup from both parentId and join table)",
          "Move, unlink, and drag-and-drop operations now immediately update the right pane without requiring a page refresh (fixed cache invalidation for all affected groups)",
        ],
      },
    ],
  },
  {
    version: "1.2.1",
    date: "2025-04-11",
    sections: [
      {
        title: "Improved",
        items: [
          "Unlinking a sub-group now moves it one level up to its grandparent instead of jumping to root level",
          "Unlink button tooltip for sub-groups shows the destination (e.g. 'moves up to ParentName' or 'moves to root level')",
          "Unlink button tooltip for devices shows 'Remove device from this group'",
        ],
      },
      {
        title: "Fixed",
        items: [
          "Circular reference protection added to the Add Member endpoint — prevents adding an ancestor group as a sub-group",
          "Add Member endpoint now keeps both the parentId column and group_subgroups join table in sync",
          "Unlink endpoint validates membership before allowing the operation",
        ],
      },
    ],
  },
  {
    version: "1.2.0",
    date: "2025-04-11",
    sections: [
      {
        title: "Added",
        items: [
          "Resizable divider between the directory tree and group detail panels — drag to resize, position saved per user between sessions",
          "Sub-groups and devices in the detail pane now have drag handles — drag them onto any group in the left tree or onto the root drop zone to move/add",
          "Dragging a device from the detail pane onto a group in the tree adds it to that group",
        ],
      },
      {
        title: "Fixed",
        items: [
          "Removing a sub-group member via the unlink button now correctly updates the left tree hierarchy (previously only the join table was updated, leaving the parentId stale)",
        ],
      },
    ],
  },
  {
    version: "1.1.0",
    date: "2025-04-10",
    sections: [
      {
        title: "Added",
        items: [
          "Move Group feature: relocate any group (with its subgroups and devices) to a different parent or to root level via a dedicated Move dialog",
          "Drag-and-drop group rearrangement: grab the 6-dot handle on any group row and drop it onto another group to reparent, or onto the root drop zone to make it top-level",
          "Circular reference protection prevents moving a group under itself or any of its descendants",
        ],
      },
    ],
  },
  {
    version: "1.0.2",
    date: "2025-04-10",
    sections: [
      {
        title: "Added",
        items: [
          "Version number displayed on login screen and sidebar, with clickable changelog dialog showing release history",
          "Changelog file and versioning schema (SemVer with -b pre-release tags)",
          "Renamed all \"Router\" references to \"Device\" across the UI to reflect support for any SSH-enabled device",
        ],
      },
      {
        title: "Improved",
        items: [
          "Added inline comments across all backend source files for improved readability and maintainability",
          "Updated internal documentation with database optimization patterns and input validation guidelines",
        ],
      },
      {
        title: "Optimized",
        items: [
          "Batched group resolution with iterative BFS — processes all groups at a given depth in 2 parallel queries",
          "Pre-passed task IDs avoid one SELECT per device during job execution",
          "Job cancellation status checked every 5th device instead of every iteration (80% fewer DB queries)",
          "Combined multiple UPDATE statements per task into a single query",
          "Parallelized group detail queries with Promise.all()",
          "Snippet tag filtering uses PostgreSQL's native array containment operator",
          "Device list endpoint selects only needed columns instead of SELECT *",
          "New database indexes: GIN index on snippet tags, composite index on job tasks",
        ],
      },
      {
        title: "Fixed",
        items: [
          "Critical bug: member deletion was removing ALL members from a group instead of just the specified one",
        ],
      },
      {
        title: "Security",
        items: [
          "Reduced dependency vulnerabilities from 16 to 2",
          "Updated drizzle-orm, vite, picomatch, path-to-regexp, lodash, brace-expansion, yaml",
          "Added input validation: NaN checks, array size limits, length limits on SSH responses",
        ],
      },
    ],
  },
  {
    version: "1.0.1",
    date: "2025-03-15",
    sections: [
      {
        title: "Added",
        items: [
          "README deployment documentation with Docker Compose and manual Docker methods",
          "Upgrading instructions with data safety explanation",
        ],
      },
    ],
  },
  {
    version: "1.0.0",
    date: "2025-03-01",
    sections: [
      {
        title: "Added",
        items: [
          "Multi-user authentication with admin and operator roles",
          "Device management with CRUD and bulk import from CSV/Excel",
          "Hierarchical device groups with nested subgroup support",
          "Modular code snippet library with tag-based categorization",
          "Batch SSH job execution across multiple devices",
          "Per-device variable injection via Excel/CSV with {{TAG}} syntax",
          "Interactive SSH mode with live streaming and prompt detection",
          "Auto-confirm mode for unattended y/n prompt handling",
          "Control character injection in scripts (<<CTRL+C>>, <<TAB>>, etc.)",
          "Detailed SSH connection logging with timestamped events",
          "Real-time reachability checks",
          "Job scheduler with one-time, interval, and weekly recurrence",
          "Job rerun and cancellation support",
          "Drag-to-reorder interface elements",
          "Docker deployment with auto-migration entrypoint",
        ],
      },
    ],
  },
];
