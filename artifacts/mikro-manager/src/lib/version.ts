export const APP_VERSION = "1.3.1";
export const APP_VERSION_DATE = "2025-04-11";

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
