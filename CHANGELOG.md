# Changelog

All notable changes to SSH Commander are documented in this file.

Versioning follows [Semantic Versioning](https://semver.org/):
- **MAJOR** (X.0.0) — major feature additions or breaking changes
- **MINOR** (x.Y.0) — substantial fixes and minor new features
- **PATCH** (x.y.Z) — minor fixes and optimizations
- **Pre-release** — tagged as `-b1`, `-b2`, etc. (e.g., `1.1.0-b1`)

When a higher number increments, lower numbers reset to zero (e.g., `1.0.5` → `1.1.0`).

---

## [1.11.0] - 2026-04-21

### Security
- **Operator accounts can no longer mutate the device fleet.** The write endpoints on routers, groups, and schedules (POST/PUT/DELETE, plus router import, group member add/remove, and per-device + bulk fingerprint refresh — both of which persist `vendor/osVersion/model/lastFingerprintAt`) now require admin role — operators get 403. Previously any signed-in user could add, edit, or delete any device, group, schedule, or fingerprint row. Read access is unchanged: operators still see the lists and can run jobs against existing devices.
- **Per-job authorization (IDOR fix).** Every `/jobs/:id*` endpoint — `GET /jobs/:id`, `/jobs/:jobId/tasks/:taskId`, `/jobs/:id/live` (SSE), `/jobs/:id/export`, `/jobs/:id/parked-tasks`, `PUT`, `DELETE`, `/rerun`, `/cancel`, `/respond`, parked-task `provide-input` and `abort`, and the global `GET /tasks/parked` — now enforces "admin OR you created the job". Previously these only checked `requireAuth`, so any signed-in operator could read or mutate another operator's job (and its connection logs / device output / sensitive command results) by guessing the id. Operators get a 404 (not 403) on someone else's job to avoid leaking job-id existence. The list-scope fix on `GET /jobs` is the same change.
- **CSV/Excel tag substitution strips control bytes.** `applyTagSubstitution` now strips `\x00`–`\x1F` (except newline) and `\x7F` from substituted values, so a hostile or malformed cell can't smuggle ESC sequences, NUL bytes, or other C0 control characters onto the SSH wire and wedge legacy CLIs. Newline (`\n`) is deliberately preserved because operators legitimately substitute multi-line values (banner text, multi-step config blocks).
- **Logout actually clears the session cookie.** `POST /auth/logout` was destroying the server-side session row but leaving the `connect.sid` cookie on the browser, which would then re-attach to the next request and silently issue a new empty session under the same id. The endpoint now sends `Set-Cookie` with `Max-Age=0` (and matching `path/httpOnly/sameSite/secure` attributes) so the browser drops the cookie immediately.

### Fixed
- **Multi-instance scheduler safety.** The 30-second tick is now wrapped in a Postgres *transaction-scoped* advisory lock (`pg_try_advisory_xact_lock`, run inside a drizzle transaction). On single-instance deployments this is a no-op (the lock is always free). On HA / rolling-deploy setups where two API replicas were briefly running together, both schedulers were racing on the same due schedules and cloning every template job N times. Only one replica's tick runs per round; the other(s) skip cleanly. The xact-scoped variant (vs. session-scoped) auto-releases on commit on the same pooled connection, so we can't leak the lock when pooled connections rotate.
- **Atomic job and group deletes.** Three multi-step writes that could leave orphan rows on partial failure are now wrapped in transactions: `POST /jobs` (parent job + per-device tasks + status flip), `DELETE /jobs/:id` (schedules + tasks + parent), and `DELETE /groups/:id` (router members + parent links + child links + group). Previously, a mid-cascade failure could deadlock the UI showing 0/0 tasks forever or leave orphan join-table rows pointing at deleted ids.
- **Production startup refuses memory-store sessions.** `app.ts` used to fall back to express-session's in-process `MemoryStore` with a warning when `DATABASE_URL` was missing. In production this silently breaks login on every container restart and on every multi-replica deployment (the store isn't shared across processes). It's now a hard error: the server refuses to start in production without a session store.

### Internal
- Added a `requireAdminAuth(req)` helper in `lib/auth.ts` that combines `requireAuth` + `getCurrentUser` + `requireAdmin` into one call and returns the resolved user. The eleven mutation endpoints touched in this release use this consistently instead of repeating the three-line pattern.

### Future work (deliberately deferred)
These items came out of the same audit but were skipped from 1.11.0 because they require destructive schema migrations, coordinated FE rewrites, or new schema columns:
- Pagination (`?limit=&offset=`) on `GET /routers`, `GET /jobs`, and `GET /groups`. Large fleets currently round-trip every row on every list refresh.
- `timestamp` → `timestamptz` schema migration. All time columns currently store naïve local time; cross-timezone deployments can show drift.
- Foreign-key cascade indexes on `job_tasks.job_id`, `schedules.job_id`, `group_routers.group_id`, etc.
- Per-credential-profile SSH algorithm split. Today every connection uses the same expanded legacy-friendly algorithm list.
- Replace parked-task polling (sidebar amber badge) with an SSE channel.
- Frontend `EventSource` cleanup on the job-detail page when the tab loses visibility.
- `admin/terminals.tsx` `AbortController` cancellation of in-flight 5s refresh fetches on unmount.

---

## [1.10.1] - 2026-04-21

### Internal
- **TypeScript cleanup pass.** A wide LSP sweep surfaced ~50 pre-existing type errors that had accumulated under the radar — none of them caused by the 1.10.0 SSH refactor. The per-package `tsc` builds had been passing because cross-package errors only show up under `pnpm -r run typecheck`. All resolved with no behaviour change. Specifics:
  - Disambiguated duplicate exports in `@workspace/api-zod` (orval emits the same param/response types in both `api.ts` and `types/`; explicit re-exports in the barrel file pick the canonical one).
  - Rebuilt `@workspace/db` declarations (stale `tsbuildinfo` + missing `dist/index.d.ts` had cascaded into TS6305 across consumers and TS2339 on `db.update().set({}).cascade()` chains).
  - Eight `useQuery` call sites now pass `queryKey` explicitly — TanStack Query v5 tightened `UseQueryOptions` so the orval-generated hook wrappers can no longer infer it for you when you also pass `enabled`/`refetchInterval`. Affected: `auth-context`, `credentials`, `groups`, `jobs/detail`, `jobs/new`, `scheduler/new`, `users`.
  - `admin-terminals.tsx` was treating the `customFetch` return value as a raw browser `Response` (calling `.ok` and `.json()` on it). Same regression pattern fixed in 1.8.22 — `customFetch<T>()` returns the parsed body directly and throws `ApiError` on non-2xx. Rewrote both call sites to use try/catch.
  - `jobs/new.tsx` was missing the `useConfirm` import + hook — the 5+ device safety prompt would have thrown `confirmDialog is not defined` at runtime the moment an operator tried to run a large-batch ad-hoc job.
  - `lucide-react` v0.541 removed the `title` prop from icon SVGs — wrapped the two reachability indicators in `<span title=…>` so the tooltip still works.
  - `useRef<…>()` calls now pass an explicit initial value (React 19 / `@types/react` 19 made the no-arg overload an error).
  - `SSH_ALGORITHMS` now declares `import('ssh2').Algorithms` instead of the inferred `string[]` shape, so the four `conn.connect({ algorithms })` sites no longer need `any`-cast escape hatches.
  - `scheduler.executeJobTasks` coerces `options.autoConfirm` from `boolean | null` to `boolean | undefined` at the `executeSSH` call site.

---

## [1.10.0] - 2026-04-21

### Internal
- **SSH primitive consolidation.** The connect-and-PTY logic was duplicated across three places:
  - the auto-confirm batch path in `lib/ssh.ts` (`executeOnce`),
  - the per-device standalone terminal in `routes/router-terminal.ts`,
  - and the interactive job runner in `lib/interactive-session.ts`.

  Each had its own copy of: dial-and-handshake, `connectViaJumpHost` wiring, host-key TOFU, the shared `SSH_ALGORITHMS` list, the `24×200 vt100` PTY config, the smart cursor-DSR responder (`makeCursorResponder`), and the stateful ANSI stripper (`stripAnsiStream` + `flushStripState`). Every fix from 1.8.20 onward (DSR responder, binary-decode ANSI stripping, explicit PTY dimensions, post-prompt idle timer) had to be applied three times by hand, and one of the three paths always lagged.

  Extracted a shared **SSHSession primitive** in `lib/ssh.ts`:
  - `connectSSH(opts, listeners)` — opens a direct or jump-host SSH connection with the project's standard algorithm list, optional host-key TOFU, and listener attachment that's safe across both paths (handshake fires only on the direct path; bastion path resolves post-handshake — documented).
  - `openInteractiveShell(conn, opts?)` — opens a PTY shell with the standard `24×200 vt100` config and returns a handle exposing the underlying `stream`, a `cursorRespond(chunk)` for raw-byte consumers, a `processData(chunk, source?)` for stream-stripped consumers, and a `flushTail()` for end-of-stream drainage.

  The three upper state machines on top (auto-confirm prompt detection + parking in `executeOnce`, multi-device SSE coordinator + sequenced send in `interactive-session`, raw-byte browser pipe in `router-terminal`) are unchanged.

### Notes
- No user-visible behaviour change. Same wire-log lines, same prompt detection, same parking, same terminal rendering, same fingerprinting. Strictly an internal cleanup so the next SSH-layer fix only has to be made once.
- `ConnectSSHOptions.hostKeyTrust` is optional (only the legacy `executeOnce` ad-hoc / fingerprint path may pass undefined; all router-attached operations pass a real trust object).

---

## [1.9.0] - 2026-04-21

### Added
- **"Needs Attention" mid-session for auto-confirm jobs.** When the shell hits a prompt the auto-responder doesn't recognise, the SSH session is now parked instead of closed on idle. The task flips to `waiting_input`, the timeout is stood down (30-min hard ceiling), and the job detail page shows an amber panel with the prompt and per-device **Submit** / **Abort** controls. Submitting writes the input into the still-open stream and the run continues; aborting marks the task failed.
- **Audio attention cue.** Short two-tone Web Audio beep when a new device parks. Throttled to once per 2s and only fires on the rising edge.
- **Sidebar parked-tasks badge.** Amber count badge next to "Batch Jobs" whenever any task is parked. Polled every 10s.
- **New REST endpoints:** `GET /api/tasks/parked`, `GET /api/jobs/:id/parked-tasks`, `POST /api/jobs/:jobId/tasks/:taskId/provide-input`, `POST .../abort`.

### Improved
- **Theme legibility.** Destructive red lightened (`0 63% 31%` → `0 84% 65%`, white foreground) so failed badges and buttons are legible in dark mode. Text selection now uses explicit `::selection` rules so highlighted text stays readable on every component.

### Notes
- Parking is opt-in via a new `taskContext` on `executeSSHCommand`; fingerprint, the standalone terminal, and the interactive (`autoConfirm=false`) path are unchanged.
- No schema migration — `waiting_input` and `prompt_text` already exist.

---

## [1.8.29] - 2026-04-20

### Added
- **"Needs Attention" task status.** New task state sitting between `success` and `failed`. After every successful SSH run the scheduler now scans the output for ~25 vendor-aware failure signals (`% Invalid input`, `% Bad command`, `syntax error`, `permission denied`, `command not found`, etc.; deliberately skips bare `wrong`/`bad`/`denied` to avoid false positives on e.g. "wrong password message"). A match flips the task to `needs_attention`, populates a new `failureReason` column, and counts it as failed at the job level. The job detail page shows an amber triangle badge with the matched reason in a tooltip so operators can spot devices that "technically ran" but actually rejected the script.
- **Admin "Active Terminals" page.** New sidebar entry (admin only) at `/admin/terminals` listing every live standalone-terminal SSH session on the API server: user, device, opened-at, idle time, with a one-click **Disconnect** button. Auto-refreshes every 5s. The disconnected operator sees `[disconnected by admin <username>]` in their terminal so they're not left wondering what happened. Idle times over 5 min are highlighted in amber so stuck sessions stand out. Backed by two new admin endpoints (`GET /admin/terminals`, `DELETE /admin/terminals/:key`).

### Improved
- **Post-prompt idle timer raised from 3s to 10s.** Once the command has been sent to the device and output starts streaming back, the auto-confirm shell now allows up to 10 seconds of silence between chunks before considering the response complete (was 3s). Pre-prompt wait stays at 25s. Helps slower devices and longer-running commands that emit output in bursts.
- **Standalone terminal brought up to parity with Batch Jobs / Fingerprint.** The "Open Terminal" page from the devices list was written before most of the SSH hardening and was missing several things. Now it:
  - Resolves credentials through `resolveEffectiveCreds` — devices attached to a credential profile (with no inline password) can now be opened from the terminal page, same as they already could from jobs and fingerprint.
  - Supports **bastion / jump-host** routing via `connectViaJumpHost` when the profile has a `jumpHostId`.
  - Passes the shared `SSH_ALGORITHMS` list so legacy MikroTik / Cisco devices negotiate KEX, ciphers, and HMACs successfully.
  - Opens the PTY with explicit `rows: 24, cols: 200, term: "vt100"` — cols=200 stops RouterOS auto-wrapping, vt100 quiets the worst banner escape garbage.
  - Runs the smart **DSR cursor responder** (`makeCursorResponder`) so RouterOS-style devices don't block waiting for a cursor-position reply.
  - Decodes SSH chunks as `binary` (was `utf8`) so RouterOS's single-byte C1 CSI (0x9B) isn't mangled, then pipes them through the stateful ANSI stripper (`stripAnsiStream` + `flushStripState`) so escape sequences split across TCP frames reassemble cleanly and the final prompt isn't eaten on close.
  - Uses the shared TOFU host-key verifier on both direct and jump-host paths.
- **Concurrency bumped 10 → 20** everywhere SSH sessions are batched: scheduler's `executeJobTasks`, ad-hoc job runs in `routes/jobs.ts`, and the "Fingerprint all" endpoint in `routes/routers.ts`. Twice the throughput against large fleets while still keeping a sane socket ceiling.
- **Terminal session hygiene.** Standalone terminals were previously only cleaned up when the user closed the tab, reconnected to the same device, or the SSH side hung up. Added two safety timers:
  - **Idle timeout** — 10 minutes of complete silence in either direction auto-closes the session with `[session idle for 10 min — auto-closed]`. Reset on any SSH output *and* on any operator keystroke.
  - **Hard ceiling** — 1 hour from session start, never reset, closes with `[session reached the 60-minute hard limit — auto-closed]`. Anything longer should be a Batch Job with proper audit trail.

### Fixed
- **RouterOS fingerprint returning banner ASCII art as the model** (e.g. `"MMM MMM KKK TTTTTTTTTTT KKK"` instead of `RB4011iGS+`). The `+cte` user-suffix doesn't always suppress the login banner on every RouterOS firmware, and banner lines like `MMM MMM KKK` were passing the old `/^[A-Za-z][A-Za-z0-9+\-/. ()]*$/` board-name filter. Two-layer fix: (1) the v7 `:put` parser now anchors its search window *after* the echoed `:put [/system resource get board-name]` line, so the banner isn't even visible to the parser; (2) candidate model lines must now contain at least one digit (real RouterOS board names always do — `RB4011iGS+`, `CCR2004-1G-12S+2XS`, `RB962UiGS-5HacT2HnT`, `CRS328-24P-4S+` — banner ASCII art never does). Either fix alone would be sufficient; both gives belt-and-braces.

---

## [1.8.28] - 2026-04-20

### Improved
- **Job output pane is now as clean as the connection log.** v1.8.27 fixed the wire log via the per-line terminal emulator, but the *output* pane (the text the operator actually reads as the result of the job) was still using the old flat `stripAnsi().trim()`. So users still saw "DěH" leading garbage, the splash banner's many empty padding lines, and the duplicated `/system identity print/system identity print` command line. New `tidyText()` helper applies `tidyLine` per line and trims leading/trailing blank lines; all output-producing sites (both auto-confirm shell paths in `ssh.ts`, the exec path, and the interactive-session resolver) now use it instead. Output for the standard RouterOS identity test now reads as just the banner once and then `name: <hostname>`, with no escape gunk on either side.

---

## [1.8.27] - 2026-04-20

### Improved
- **Connection log is much cleaner.** v1.8.26 made jobs run successfully against RouterOS but the wire log was full of two kinds of noise:
  
  1. **Stray control bytes (`�`, garbled chars).** The previous ANSI stripper only knew about the 7-bit form of escape sequences (e.g. `\x1b[6n`). It didn't recognize the C1 single-byte forms (e.g. `\x9b` is the single-byte equivalent of `\x1b[`), so those bytes leaked through and rendered as `�` or `ě` depending on whether the buffer happened to UTF-8-decode them as part of a valid sequence.
  
  2. **Each command appearing twice.** RouterOS interactive mode echoes a typed command character-by-character, then sends `\x1b[<N>D` to back the cursor up by N chars, then re-renders the same command with syntax-highlight colors. On a real terminal that's "type, back up, overwrite" — the second copy *replaces* the first on screen. Our flat ANSI stripper just removed the color codes, leaving both copies in the log:
     ```
     << [admin@...] > /system identity print/system identity print
     ```
  
  Both fixed by routing every wire-log line through `tidyLine()`, a small per-line terminal emulator. It maintains a virtual cursor and a line buffer, and processes:
  - **CR** (`\r`) → cursor to column 0
  - **Cursor back** (`\x1b[<N>D`) → cursor -= N (clamped)
  - **Cursor forward** (`\x1b[<N>C`) → cursor += N
  - **Line erase** (`\x1b[K`, `\x1b[1K`, `\x1b[2K`) → erase to EOL / to BOL / entire line
  - **Other CSI** (color codes, cursor-pos to row, DSR, etc.) → silently dropped, no effect on buffer
  - **C0 controls** (other than tab/newline/CR) and **C1 controls** (`0x80`–`0x9F`, including the single-byte CSI form) → dropped
  - **Text writes** → write at cursor, advance, padding with spaces if cursor jumped past end
  
  Net effect: that earlier 16-line wire-log block from the test run will now read about 5 lines — the splash banner once, the prompt once, the command once, the result once, the trailing prompt once. No `�` characters, no doubled commands.
  
  Scope is intentionally **per-line**, not full screen emulation. Multi-line cursor moves are rare in our use case and full emulation would be a much bigger change. If a device does something exotic across line boundaries the worst case is the log looks like it did before.

---

## [1.8.26] - 2026-04-20

### Fixed
- **RouterOS jobs still hanging after 1.8.25.** The wire log from the failed v1.8.25 run revealed two more compounding root causes that I missed by guessing instead of looking at the data:

  1. **Dumb DSR responder confused RouterOS into a re-probe loop.** The 1.8.25 responder always replied `\x1b[1;1R` to any cursor-position query. But RouterOS doesn't ask once — it runs a *terminal-size discovery ritual*: send `\x1b[9999B` (cursor down a lot) → DSR (where am I?) → `\x1b[H` (home) → DSR → `\x1b[9999C` (right edge) → DSR. It then *deduces* terminal dimensions from the answers. Telling it the cursor is at 1;1 every time is telling it the terminal is 1 row by 1 column, which sends it into an infinite re-probe loop and the prompt never appears. Replaced with `makeCursorResponder()`, a smart responder that:
     - Maintains a virtual cursor clamped to (rows, cols) — currently 24×200, matching the PTY config.
     - Walks each chunk for cursor-movement CSI sequences (`A`/`B`/`C`/`D` for up/down/right/left, `H`/`f` for absolute position) and updates the virtual cursor.
     - Replies to `\x1b[6n` with the current virtual position. RouterOS now gets `\x1b[24;1R` after a "down 9999", `\x1b[1;1R` after a "home", `\x1b[1;200R` after a "right 9999" — all consistent with a real 24×200 terminal. It deduces correctly and stops probing.
     
     Wired into all three SSH shell paths (auto-confirm, retry-wrapped, interactive-session).

  2. **3-second idle-close timer killed the session during prompt-wait.** The auto-confirm shell mode in `ssh.ts` had an idle timer that fired 3 seconds after the last received byte. Once RouterOS finished its initial probe burst, it went silent waiting for our DSR replies; the device's silence triggered our idle timer, the session closed, and the 20-second prompt-wait ceiling never had a chance to fire. The idle window is now **25 seconds while waiting for the prompt** (longer than the 20s prompt ceiling) and drops to **3 seconds once the command is sent**. Same fix on both auto-confirm shell paths in `ssh.ts`. `interactive-session.ts` was already correctly no-opping the idle handler before `commandSent`, so it didn't need this fix.

  3. **Cleanup.** The prompt-wait `setInterval` is now properly `clearInterval`'d on stream close in both `ssh.ts` shell paths, so it can't leak past the session ending.

  Net effect: connection log on a successful RouterOS job should now show `Waiting for shell prompt (max 20s)` → a few hundred ms of `<<` chunks where the device probes and we reply with cursor positions → `Shell prompt detected after Nms` → `>> /system identity print` → real device output streamed back.

---

## [1.8.25] - 2026-04-20

### Fixed
- **MikroTik RouterOS (and similar) jobs running but doing nothing.** The 1.8.24 prompt-wait fix only patched `interactive-session.ts`; the auto-confirm code path that most jobs actually use lives in `ssh.ts` and still had the old hardcoded 500ms delay. Both `conn.shell()` paths in `ssh.ts` (the direct one and the retry-wrapped one) now use the same prompt-wait + 20s ceiling logic. Three execution paths total, all consistent now.
  
- **RouterOS terminal-size-probe deadlock.** Even with prompt-wait in place, RouterOS jobs would still hit the 20s ceiling because of a deeper issue: when RouterOS opens an SSH shell it emits `\x1b[999;999H\x1b[6n` — "move cursor to row 999/col 999, then report cursor position" — and **blocks waiting for a Device Status Report reply** before printing its prompt. Without a reply, no prompt ever appears. The wire log made this visible: every session showed `<< [9999B` and `<< [9999BZ  [6n` (the leading `\x1b` rendered invisibly) and nothing else.
  
  Two-pronged fix:
  1. **Explicit PTY config.** All three `conn.shell()` calls now pass `{ rows: 24, cols: 200, term: "vt100" }`. With explicit dimensions most devices skip the probe entirely. `cols: 200` also stops RouterOS from auto-wrapping long output lines mid-table.
  2. **DSR auto-responder.** As a belt-and-braces fallback, the data handlers in both `ssh.ts` shell paths now scan each chunk for `\x1b[6n` and immediately reply with `\x1b[1;1R` (cursor at row 1, col 1). Once replied to, devices stop asking. `interactive-session.ts` doesn't need this because the explicit PTY alone is enough for the slower interactive flow, but we may add it there too if any device still misbehaves.
  
  Net effect: RouterOS prompts now appear within a few hundred milliseconds of shell open, the prompt-wait succeeds quickly, and the script actually executes against a ready shell. Connection log will read `Waiting for shell prompt (max 20s)` → `Shell prompt detected after Nms` → `>> /system identity print` → device output.

---

## [1.8.24] - 2026-04-20

### Fixed
- **Race between shell opening and script send on slow-initializing devices.** The interactive runner used to wait a flat 500ms after `conn.shell()` returned and then dump the entire script into the stream. That worked for fast Linux boxes but not for chatty devices — MikroTik RouterOS, Cisco IOS, anything behind RADIUS — where the shell takes several seconds to print its banner and emit the first prompt. During that window the device's TX is pure terminal-init escape sequences (color codes, cursor probes, bracketed-paste toggles), so on the operator side the output pane looked frozen with only control-character noise, and on the device side the script's first command landed in a not-yet-ready shell and was either dropped or interpreted as garbage. Net effect: the job "ran" but did nothing.
  
  Fix: replaced the fixed `setTimeout(..., 500)` with an active wait. We poll `dev.shellBuffer` every 100ms, strip ANSI from the current buffer, and check for a "prompt-shaped" tail using `/(?:^|\n)[^\n]*[>#$%\]:][ \t]*$/` — i.e. any of the typical CLI prompt characters at the very end of the buffer with no trailing newline. As soon as a match is found we flip `commandSent = true` and proceed exactly as before. A 20-second hard ceiling guarantees we always send eventually, even if the device never shows a recognisable prompt — in that case the log records `No shell prompt detected after Nms — sending command anyway` so operators know we fell back. On success the log records `Shell prompt detected after Nms` so you can see exactly how long that particular device took to come up.
  
  The script-directives runner (`<<SLEEP>>` / `<<WAIT>>`) sits inside the same `.then()` callback so it benefits automatically. Connection-log timing now reads naturally: `Waiting for shell prompt (max 20s)` → `Shell prompt detected after 1820ms` → `Executing command (3 line(s)): ...`.

---

## [1.8.23] - 2026-04-20

### Fixed
- **ANSI escape codes leaking into the live output pane** — operators were seeing visible junk like `[9999B`, `Z`, `[6n` in the SSE-streamed "Output" tab even though 1.8.20 added `stripAnsi`. The bug: `stripAnsi` is a pure-function-on-a-complete-string, but it was being called on every individual TCP chunk. When a device emitted `\x1b[6n` (Device Status Report) at a TCP boundary that put `\x1b` at the very end of frame A and `[6n` at the start of frame B, neither chunk had a complete CSI sequence to match. The lone `\x1b` was then consumed by the C0/C1 control-char regex, frame B had no anchor, and `[6n` flowed through to the UI unmodified. Same mechanism explained the `[9999B` (terminal-height probe) and `Z` (cursor-back-tab) leaks.
  
  Fix: a new `stripAnsiStream(state, chunk)` paired with `makeStripState()` and `flushStripState(state)` (all in `lib/ssh.ts`). It scans for the last `\x1b` in `pending + chunk`, decides whether the escape sequence starting there is complete (CSI ends on `0x40-0x7E`, OSC on BEL or ST, charset selectors are 3 chars, single-shifts are 2 chars), and if not, holds the partial tail back as `pending` for the next chunk to complete. Pending is capped at 64 chars so a stuck stream can't pin output forever — past that we flush. On stream close `flushStripState` drains anything still held so the trailing prompt line isn't lost. Wired into `interactive-session.ts`'s shell-data handler. The wire log (`>>` / `<<`) still receives raw bytes intentionally — that's the diagnostic view of what actually went over the socket.
  
  The whole-string `stripAnsi(dev.shellBuffer)` calls at finalize time are unchanged and still correct (they always operate on the complete buffer).

---

## [1.8.22] - 2026-04-20

### Fixed
- **"Unique devices" counter and live reachability dots — for real this time.** Both 1.8.19 and 1.8.21 tried to fix this and both were wrong diagnoses. The actual bug was a misuse of the shared API client: `customFetch` from `@workspace/api-client-react` returns the **parsed response body** (`Promise<T>`) and throws an `ApiError` on non-2xx responses. The two hooks (`useResolvedDeviceCount`, `useReachability`) in `pages/jobs/new.tsx` were treating the return value as a raw `Response` object — checking `res.ok` (always `undefined`, so always falsy) and calling `await res.json()` (never reached). The early-return branch `if (!res.ok) return 0;` therefore fired on every successful call, and the hooks resolved to their defaults forever. Both hooks now consume the parsed body directly and use try/catch to handle the throw-on-error contract. The query keys, memoization, and CSRF-aware request path from previous attempts are kept since they're correct on their own.

### Lessons
- `customFetch` ≠ `fetch`. It returns `Promise<ParsedBody>`, not `Promise<Response>`, and throws on non-OK. Never call `.ok`, `.json()`, or `.status` on its return value. Always either await the parsed body directly or wrap in try/catch — there's no middle ground.

---

## [1.8.21] - 2026-04-19

### Fixed
- **"Unique devices" counter and live reachability dots stuck on the New Job page.** The 1.8.19 changelog blamed array reference instability and added `useMemo` wrappers — that was a misdiagnosis. React Query already deep-compares query keys so reference identity doesn't matter. The actual bug: `useResolvedDeviceCount` and `useReachability` used the global `fetch()` instead of the shared `customFetch` from `@workspace/api-client-react`. The CSRF middleware introduced in 1.8.0 requires `X-Requested-With: XMLHttpRequest` on every state-changing `/api` request, `customFetch` adds that header automatically, plain `fetch` does not — so both POSTs were 403'ing and the catch-all `if (!res.ok) return 0` made the failure invisible. Both hooks now use `customFetch`. The `useMemo` wrappers from 1.8.19 are kept since they don't hurt and are good practice.

### Added
- **Script directives `<<SLEEP N>>` and `<<WAIT>>` for multi-step interactive jobs.** Sometimes a script needs to pause between commands — e.g. after `apt update` you want to wait a few seconds before `apt upgrade -y`, or after a long-running install you need to wait for the prompt to come back before issuing the next command. Two new tokens handle this:
  - `<<SLEEP 5>>` — pause the script runner for 5 seconds (decimals OK, e.g. `<<SLEEP 1.5>>`; clamped to 0.1s–600s per directive). The idle timer is paused during the sleep so the session doesn't auto-close mid-script.
  - `<<WAIT>>` — pause until the device's shell stops emitting data for 1.5s, i.e. until the previous command finished and the prompt returned. Bounded by the per-job timeout so a hung device can't block forever.
  
  Implementation: `parseScriptDirectives` (in `lib/interactive-session.ts`) splits the script into a list of `{kind: 'text' | 'sleep' | 'wait', ...}` segments. If any non-text segment is present the runner switches from a single `writeCommandWithControlChars` call to a sequenced `for...of` loop that sends one text chunk, awaits the sleep/wait, then sends the next. Directives are stripped before reaching the wire, so they don't appear in the device's command history. Both directives are logged in the connection log with start/end markers (`Pausing 5.0s before next segment (<<SLEEP>>)` / `Waiting for shell to go idle (<<WAIT>>)` / `Shell idle, resuming script`).
  
  The per-job `timeoutSeconds` value chosen on the New Job page is now plumbed all the way through to the interactive runner (it was previously hardcoded to 120s, which would clip any script using long pauses). `startInteractiveJob` and the per-device `connectDevice` both accept the timeout, clamped to 5s..2h. Both new-job code paths (fresh job + re-run-existing job) pass it through, and the connection log shows `Timeout: Nms` at the top of every session.

---

## [1.8.20] - 2026-04-19

### Improved
- **Connection log now shows the SSH command/response exchange.** The job-detail "Connection Log" pane previously stopped at metadata (handshake, KEX, auth, prompt detection, idle/close). Operators debugging a script that "ran but did nothing" had no way to tell whether the device echoed the command, returned an error mid-script, or was sitting on a hidden prompt. Now every line written to the stream is logged with a `>>` prefix and every line read back is logged with `<<` (stderr `<<E`), all with the same timestamp format as the rest of the log. Implemented via a new `appendWireLog` / `flushWireLog` helper in `lib/ssh.ts` that line-buffers chunked TCP data so partial writes don't fragment the log. Wired into all four SSH paths: `interactive-session.ts` (jobs page), `ssh.ts` shell + exec mode, and the retry-wrapped shell + exec mode. Hard cap of 4000 lines per session prevents pathological devices (e.g. Cisco `show tech-support`) from bloating the `connectionLog` JSON column past Postgres TOAST limits.

---

## [1.8.19] - 2026-04-19

### Fixed
- **Unique device count on New Job page stuck at 0.** `selectedRouterIds` and `selectedGroupIds` were derived inline (`targets.filter(...).map(...)`) on every render, producing a fresh array reference each time. The `useResolvedDeviceCount` query keyed on those arrays, so its cache key changed every render — every background reachability tick or polling re-render invalidated the in-flight result before it could resolve, and the hook fell back to its `0` default. Wrapped both lists in `useMemo` (and sorted them so `[1,2]` and `[2,1]` hash identically) to stabilize the key.

---

## [1.8.18] - 2026-04-19

### Fixed
- **Job status page crashed on row click.** Expanding a task triggered a temporal-dead-zone `ReferenceError` because the lazy `useQuery` for full task data referenced `job` before the `useGetJob(...)` declaration. Initial render worked (short-circuit on `expandedTask = null`), but the click that flipped `expandedTask` truthy crashed the component and bounced the user to the global error boundary. Moved the expanded-task block below `useGetJob` and added a comment so it can't drift back.

---

## [1.8.17] - 2026-04-19

### Improved
- Devices table: restored the "Added" column and dropped "SSH Config" instead. SSH user/port now appears in a tooltip when hovering the device name (in `user@ip:port` form for easy copy).

---

## [1.8.16] - 2026-04-19

### Improved
- Devices table now fits a normal laptop screen with no horizontal scroll — delete/edit icons are no longer cut off. Cell padding reduced (`px-6` → `px-3`), action icon buttons shrunk to 28px, and the "Added" date column was removed from the grid and moved into a tooltip on the device name. Table minimum width dropped from 1100px to 900px.

---

## [1.8.15] - 2026-04-19

### Improved
- Devices table no longer requires horizontal scroll on a normal laptop screen. SSH config column now stacks `username` over `:port` (was a single wide "user @ port 22" line), uptime column stacks the % over the sparkline, and the date column uses a compact font. Table minimum width dropped from 1500px to 1100px.

---

## [1.8.14] - 2026-04-19

### Fixed
- **The actual root cause of "one fingerprint kicks me out".** Two cooperating bugs:
  1. **ssh2 sync-throw crashed the whole API server.** When a TCP connection to a device dropped before the SSH handshake completed (firewall reset, wrong port, device offline mid-probe), the ssh2 library threw the error *synchronously inside a `net.Socket` event handler*. That throw never reaches `conn.on("error", …)` — no amount of per-connection error handling can catch it. It landed on `process.uncaughtException`, which the entrypoint had wired to `process.exit(1)`. The whole node process died, the container restarted, and every in-flight HTTP request from the browser failed. The browser's error toast read "HTTP 401 Unauthorized" because the FE's retry hit the next bug below. Process-level handlers now log the error loudly and keep the server alive — one bad SSH session can no longer take down the API for every other concurrent operator.
  2. **The session table was being dropped on every container start.** The `session` table (owned by `connect-pg-simple`, not by our code) was not declared in the drizzle schema, so `drizzle-kit push --force` in the docker entrypoint saw it as a stranger and dropped it. `connect-pg-simple`'s `createTableIfMissing: true` then quietly recreated it empty. Result: every container restart (including the crash-restart from bug 1) wiped every active login. Your browser's cookie pointed at a session ID that no longer existed in the database, express-session generated a fresh empty session per request, and `requireAuth` rejected every call with 401 even though your cookie was perfectly valid. The `session` table is now declared in the schema with the exact shape `connect-pg-simple` expects, so the schema sync recognises it and leaves it alone.
- The combined effect of these two fixes: a single failed fingerprint no longer crashes the server, AND even when the server is restarted (by you, by an upgrade, or by anything else), your login survives.

---

## [1.8.13] - 2026-04-19

### Fixed
- Diagnostic logging for "one fingerprint kicks me out" — every 401 now logs session state (cookie sent, session loaded, userId present) and the session store reports DB query failures instead of swallowing them. Fingerprint endpoint now catches SSH-library exceptions and returns them as a normal failed-fingerprint response so the UI can no longer misread an unexpected throw as a session expiry.

---

## [1.8.12] - 2026-04-19

### Fixed
- **Operators were getting `HTTP 401 Unauthorized` toasts mid-action** when running many fingerprint requests (or any other long-running SSH endpoint) in quick succession, then had to log in again. Root cause was pg connection-pool starvation between the session store and the rest of the app:
  - `connect-pg-simple` was being initialised with `conString`, which makes it open its **own** internal `pg.Pool` with the default of 10 connections — completely separate from Drizzle's 10-connection pool.
  - Every authenticated `/api` request reads + touches the session (2 store ops). When 10+ long-running fingerprint requests are inflight at once, the session-store pool exhausts. Subsequent session reads hang and eventually fail silently; `express-session` treats a failed read as "no session", so `userId` is undefined, and `requireAuth` throws 401 even though the cookie is still perfectly valid.
- **Fixes:**
  - The express-session store now reuses the shared Drizzle pg pool (passed via `pool:` instead of `conString:`). Session ops and app queries compete for the same pool, so a single session store can no longer be starved by a separate internal pool.
  - The shared pool's max is bumped from the default 10 to **20**, with an explicit `connectionTimeoutMillis: 10_000` and `idleTimeoutMillis: 30_000`. Bursts of parallel SSH activity no longer exhaust the pool, and if they ever do the failure is loud (a thrown error in the logs) instead of silent (a phantom 401).

## [1.8.11] - 2026-04-19

### Fixed
- **Operators were being logged out mid-action even while actively using the app.** Two compounding causes:
  - The PostgreSQL-backed session store was gated on `isProd && DATABASE_URL`, so in development the API server fell through to express-session's default in-process `MemoryStore`. Every API server restart (version bump, backend code reload, `db:push`) destroyed every session in memory and kicked everyone out. Restarts happen routinely during normal development — sometimes several times an hour — which made the symptom feel random.
  - Even when the server wasn't restarting, the session cookie's `Max-Age` was set once at login and never refreshed. With `rolling` not enabled, the 7-day window was fixed at login time and didn't extend on activity, so a long-lived session would still expire on the dot regardless of how active the operator was.
- **Fixes:**
  - The PostgreSQL session store is now used whenever a `DATABASE_URL` is set, including in development. Sessions survive API server restarts. (If somehow there's no `DATABASE_URL`, the in-memory store is still used as a fallback and a warning is logged at startup.)
  - `rolling: true` is now set on the session config, so every authenticated request slides the 7-day cookie expiry forward. An operator who's actively using the app will never be logged out by timeout.

## [1.8.10] - 2026-04-19

### Added
- **Hardware model number** is now detected and displayed alongside vendor and OS version. The Devices table column has been renamed *Vendor / Model / OS* and shows three lines per device:
  - **MikroTik:** RouterOS board name (e.g. `RB4011iGS+`, `CCR2004-1G-12S+2XS`, `hAP ax³`) via `:put [/system resource get board-name]` and `board-name:` from `/system resource print`. The v7 probe now fetches version + board-name in a single SSH session via combined `:put` calls — no extra round-trip cost.
  - **Cisco:** Model from `show version` — tries the explicit `Model number :` line first, then falls back to the `cisco <MODEL>` line near the top of the output (covers `WS-C2960-...`, `ISR4321/K9`, `C9300-24P`, etc.).
  - **Linux:** DMI product name from `/sys/class/dmi/id/product_name`. Common whitebox-hardware placeholder strings (`To be filled by O.E.M.`, `System Product Name`, `Default string`) are filtered out so the column stays blank rather than showing garbage.
- New `model` column on the `routers` table. Existing rows have `model = NULL` until re-fingerprinted; click *Fingerprint* (or use *Fingerprint All*) to populate.
- **Devices page search** now matches against vendor, model, and OS version in addition to name and IP. Type "mikrotik", "RB4011", or "RouterOS 7" into the search box to filter the list.
- **Devices page sort** has three new options: *Vendor*, *Model*, and *OS*. Devices that haven't been fingerprinted yet (empty values) sort to the end in ascending order.

## [1.8.9] - 2026-04-19

### Fixed
- **Devices table not refreshing after fingerprint / re-pin / delete.** Three actions on the Devices page (`Fingerprint`, `Re-pin SSH host key`, and `Delete`) were calling `queryClient.invalidateQueries({ queryKey: ["/routers"] })` — but the actual cache key used by the device list query is `["/api/routers"]`. So the mutations succeeded server-side (vendor / OS were saved, host key cleared, row deleted) but the table never refetched, leaving the UI showing the stale row until the user manually reloaded the page. Most visible after a fingerprint succeeded: the Vendor / OS column kept showing "unknown". All three call sites now invalidate the correct key and the table updates immediately.

## [1.8.8] - 2026-04-19

### Fixed
- **MikroTik fingerprint returning `"no probe matched"`** on devices that otherwise respond normally to SSH. Two root causes were addressed:
  - RouterOS interactive shells emit ANSI/VT100 escape sequences (colour, cursor moves, terminal-type queries) that were embedding control bytes in the middle of the literal `version:` string the regex was looking for.
  - RouterOS v7 sometimes prints the version on a different line than v6 (or via a header like `RouterOS 7.13.5` rather than the `version: ...` column).
- The MikroTik probe now:
  - Appends the RouterOS `+cte` session-flag suffix to the username (`c`=no colour, `t`=no terminal-detect, `e`=no escape sequences) so the device sends clean output in the first place. Non-MikroTik devices reject this username with an auth error, which is the expected signal to fall through to the Cisco / Linux probes.
  - Strips ANSI/VT100 escape sequences before parsing, as a belt-and-braces measure.
  - Tries a terse `:put [/system resource get version]` command first, which on RouterOS v7 returns just the version string on its own line — much easier to parse and immune to MOTD/banner noise.
  - Accepts the alternative `RouterOS X.Y.Z` header format as well as the `version:` column.
- When no probe matches, the error message now includes the first 300 characters of what the device actually sent back (with ANSI codes stripped), so unsupported vendors or unexpected banners can be diagnosed from the UI without digging into server logs.

## [1.8.7] - 2026-04-19

### Fixed
- Credential profiles are now honoured by **every** SSH code path — fingerprint probes, ad-hoc batch jobs, scheduled jobs, and interactive jobs. Previously only the ad-hoc batch runner read the profile; the other three paths read the device's inline `sshUsername` / `sshPassword` columns directly, so any device managed via a credential profile would attempt to connect with whatever (often empty) inline values happened to be on the row, producing `authentication methods failed` errors with no obvious cause.
- A new shared `resolveEffectiveCreds(router)` helper centralises the resolution rules: profile takes precedence per field with the inline column as fallback, and the bastion is pulled from `profile.jumpHostId` → another profile's `jumpHost` / `jumpPort` fields. All four call sites now use it.
- Per-device enable/sudo password (auto-respond on mid-session prompts) is now applied in scheduled jobs, interactive jobs, and fingerprint probes — previously only ad-hoc batch runs picked it up from the profile.
- Bastion / jump host routing is now applied in scheduled jobs, interactive jobs, and fingerprint probes. Interactive jobs previously connected straight to the target IP regardless of the profile's `jumpHostId`. The new path uses the same `connectViaJumpHost` helper as ad-hoc runs.
- When a device has no resolvable SSH password at all (no inline value and no profile password), the error message is now explicit — *"No SSH password configured (check the credential profile or set an inline password)"* — instead of the generic *"All configured authentication methods failed"* that previously made misconfigured profiles look like network or credential problems.

## [1.8.6] - 2026-04-19

### Changed
- Folded the schedule calendar into the Scheduler page. The standalone "Calendar" sidebar entry and the `/scheduler/calendar` route have been removed; the Scheduler page now has a single **List ↔ Calendar** toggle button next to **New Schedule** that switches between the two views in place. The selected view is persisted in `localStorage` so the user lands on whichever view they were last using.

## [1.8.5] - 2026-04-19

### Fixed
- Continued login-loop fix for installations behind an HTTPS-terminating reverse proxy that does **not** forward the `X-Forwarded-Proto` header (some custom nginx configs, some Docker compose setups, plain-HTTP intranet deployments). The 1.8.4 trust-proxy default fixes the common case where the proxy *does* forward the header, but if it doesn't, `req.secure` is still false and `express-session` still drops the Secure cookie.
- New `COOKIE_SECURE` environment variable (`true` / `false`) overrides the auto-detection. Set `COOKIE_SECURE=false` if your reverse proxy strips proto headers, or if you're running on plain HTTP. Default behavior unchanged: secure in production, not in development.
- Added `proxy: true` to the `express-session` config so it correctly consults `X-Forwarded-Proto` when deciding whether to issue a Secure cookie (previously it relied solely on `req.secure`, which the Express trust-proxy setting populates — `proxy: true` belt-and-braces the same path).

## [1.8.4] - 2026-04-19

### Fixed
- Login appeared to succeed (HTTP 200 with the user object in the body) but the session cookie was never persisted in the browser, so the login dialog reappeared on the next request. The 1.8.2 default of `TRUST_PROXY_HOPS=0` in production meant that behind any HTTPS reverse proxy (Replit edge, nginx, Caddy, Traefik, Cloudflare, k8s ingress) Express saw `req.protocol === "http"` and `req.secure === false`. With `cookie.secure: true` (the production default), `express-session` then silently refused to emit the `Set-Cookie` header. The default is now `1` hop everywhere — the overwhelmingly common deployment topology. Operators who genuinely expose the container's port directly to the internet without any proxy must opt out with `TRUST_PROXY_HOPS=0` to avoid IP-spoofing of the rate limiter.

## [1.8.3] - 2026-04-19

### Fixed
- Docker container schema bootstrap. On upgrades from older releases (e.g. 1.4.x → 1.8.x), `drizzle-kit push` would hit an interactive rename-detection prompt for the new tables added in 1.5+/1.6+/1.7+ (`credential_profiles`, `device_reachability`, `saved_views`) — it offered to rename the existing `session` table (managed by `connect-pg-simple`, not in the Drizzle schema) into one of them. Even with `--force`, the prompt blocked container start, leaving those tables uncreated. The result was 500s on the credential profiles page and a flood of `relation "device_reachability" does not exist` errors from the background reachability loop.
- The defensive migration block in `docker-entrypoint.sh` now creates `credential_profiles`, `device_reachability`, and `saved_views` (and their indexes) explicitly with `CREATE TABLE IF NOT EXISTS`, so by the time `drizzle-kit push` runs there are no new tables to ask about. As a belt-and-braces measure the push step is also run with stdin closed, so any future interactive prompt fails fast instead of hanging.

## [1.8.2] - 2026-04-19

### Performance
- Per-request memoization of the current-user lookup in `lib/auth.ts`. Many routes called `getCurrentUser(req)` two or three times in the course of handling one request (auth check, then admin check, then ownership check); each call hit the database. The result is now cached on the `req` object via a Symbol-keyed property, so a single request issues at most one `SELECT` against the `users` table.
- CSRF middleware moved from `app.use((req,res,next) => req.path.startsWith('/api/'))` to `app.use('/api', ...)`. Static-asset traffic in production no longer runs the CSRF check at all, and the per-request `path.startsWith` test is gone.

### Fixed
- Express `trust proxy` is now configured via the new `TRUST_PROXY_HOPS` environment variable (default 1 in development, 0 in production). This eliminates the noisy `X-Forwarded-For` validation warning from `express-rate-limit` and ensures the login rate limiter sees real client IPs when behind a reverse proxy. The default is 0 in production so operators who expose the container directly without a proxy aren't silently exposed to IP-spoofing via forged `X-Forwarded-For` — they must opt in.
- Credential profile create/update now coerces empty-string values for the integer `jumpHostId` and `jumpPort` fields to NULL. The previous code passed them straight through, causing Postgres to fail with `invalid input syntax for type integer` and a 500 response when saving a profile with no jump host.

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
