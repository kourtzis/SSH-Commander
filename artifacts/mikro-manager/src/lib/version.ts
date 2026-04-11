export const APP_VERSION = "1.2.0";
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
