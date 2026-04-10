export const APP_VERSION = "1.0.2";
export const APP_VERSION_DATE = "2025-04-10";

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
    version: "1.0.2",
    date: "2025-04-10",
    sections: [
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
          "Pre-passed task IDs avoid one SELECT per router during job execution",
          "Job cancellation status checked every 5th router instead of every iteration (80% fewer DB queries)",
          "Combined multiple UPDATE statements per task into a single query",
          "Parallelized group detail queries with Promise.all()",
          "Snippet tag filtering uses PostgreSQL's native array containment operator",
          "Router list endpoint selects only needed columns instead of SELECT *",
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
          "Router management with CRUD and bulk import from CSV/Excel",
          "Hierarchical router groups with nested subgroup support",
          "Modular code snippet library with tag-based categorization",
          "Batch SSH job execution across multiple routers",
          "Per-router variable injection via Excel/CSV with {{TAG}} syntax",
          "Interactive SSH mode with live streaming and prompt detection",
          "Auto-confirm mode for unattended y/n prompt handling",
          "Control character injection in scripts (<<CTRL+C>>, <<TAB>>, etc.)",
          "Detailed SSH connection logging with timestamped events",
          "Real-time device reachability checks",
          "Job scheduler with one-time, interval, and weekly recurrence",
          "Job rerun and cancellation support",
          "Drag-to-reorder interface elements",
          "Docker deployment with auto-migration entrypoint",
        ],
      },
    ],
  },
];
