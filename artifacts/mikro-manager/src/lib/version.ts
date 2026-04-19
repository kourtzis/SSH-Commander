export const APP_VERSION = "1.7.0";
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
