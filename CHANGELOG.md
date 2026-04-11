# Changelog

All notable changes to SSH Commander are documented in this file.

Versioning follows [Semantic Versioning](https://semver.org/):
- **MAJOR** (X.0.0) — major feature additions or breaking changes
- **MINOR** (x.Y.0) — substantial fixes and minor new features
- **PATCH** (x.y.Z) — minor fixes and optimizations
- **Pre-release** — tagged as `-b1`, `-b2`, etc. (e.g., `1.1.0-b1`)

When a higher number increments, lower numbers reset to zero (e.g., `1.0.5` → `1.1.0`).

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
