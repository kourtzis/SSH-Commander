# Changelog

All notable changes to SSH Commander are documented in this file.

Versioning follows [Semantic Versioning](https://semver.org/):
- **MAJOR** (X.0.0) — major feature additions or breaking changes
- **MINOR** (x.Y.0) — substantial fixes and minor new features
- **PATCH** (x.y.Z) — minor fixes and optimizations
- **Pre-release** — tagged as `-b1`, `-b2`, etc. (e.g., `1.1.0-b1`)

When a higher number increments, lower numbers reset to zero (e.g., `1.0.5` → `1.1.0`).

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
- Reduced dependency vulnerabilities from 16 to 2 (remaining 2 are in `xlsx` which has no fix available — used client-side only, reduced risk)
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
