---
name: Dual prompt-handling paths (auto-confirm vs interactive)
description: Batch jobs run through one of two completely separate prompt engines depending on autoConfirm; they must be kept at feature parity.
---

# Two separate execution engines, chosen by `autoConfirm`

A batch job's `autoConfirm` flag (per-job, default true) routes execution down one of two
*independent* code paths. They do NOT share prompt-handling logic, so a fix in one is easily
forgotten in the other.

- `autoConfirm: true` → `executeOnce` in `lib/ssh.ts` (interactive shell). Auto-answers y/n.
  Unrecognised input prompts are **parked** in the `stuckPrompts` registry (`lib/stuck-prompts.ts`);
  operator answers via `POST /jobs/:jobId/tasks/:taskId/provide-input` (+ `parked-tasks/respond-all`,
  `parked-tasks/abort-all`). Frontend "Need Attention" panel.
- `autoConfirm: false` → `InteractiveSessionManager` in `lib/interactive-session.ts`. Emits
  `input_required` SSE, flips task to `waiting_input`; operator answers via `POST /jobs/:id/respond`
  → `sendInput()`. Frontend "Waiting for Input" panel (`waitingDevices`).

**Why this matters:** the two paths have drifted. Known parity gaps to watch for:
- The auto-confirm/parked path **clears the per-attempt global timeout** when it parks. The
  interactive path historically did NOT clear `dev.globalTimerRef` on `waiting_input`, so an
  operator-waiting session would still get killed by the job's `timeoutSeconds`. This was the
  real cause of "I disabled Auto Reply and sessions got stuck until they timed out."
- Both registries are **in-memory only**. On server restart, `job_tasks` rows stuck at
  `running`/`waiting_input` are orphaned (UI shows them live, but the SSH stream is dead). A
  startup reaper is needed to fail non-terminal tasks.

**How to apply:** any change to prompt detection, timeout suspension, resume, or bulk operator
actions must be mirrored in BOTH paths, and both frontend panels.
