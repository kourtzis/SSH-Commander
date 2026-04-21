// ─── Stuck-prompt parking lot ───────────────────────────────────────
// In-memory registry for SSH sessions in auto-confirm mode that hit a
// prompt the auto-responder doesn't recognise. Instead of silently
// closing on idle, executeSSHCommand parks the live ssh2 stream here
// and waits for an operator to either submit input or abort. The owning
// promise stays unresolved until one of those happens (or the 30-minute
// hard ceiling fires and we auto-abort).
//
// Scope: auto-confirm batch jobs only. The fully-interactive path
// (interactive-session.ts) and the standalone terminal page have their
// own state machines — this registry is not used by either.

import type { Client, ClientChannel } from "ssh2";

const HARD_CEILING_MS = 30 * 60 * 1000;  // 30 min — auto-abort if no input

export interface ParkedTask {
  taskId: number;
  jobId: number;
  routerId: number;
  routerName: string;
  routerIp: string;
  promptText: string;
  parkedAt: Date;
  outputPreview: string;  // last ~600 chars of cleaned shell buffer

  // Internals — not serialised over the wire
  conn: Client;
  stream: ClientChannel;
  hardTimer: ReturnType<typeof setTimeout>;
  resumeIdle: () => void;          // re-arm the post-input idle timer
  abortFn: (reason: string) => void; // close stream + reject the parent promise
}

export interface PublicParkedTask {
  taskId: number;
  jobId: number;
  routerId: number;
  routerName: string;
  routerIp: string;
  promptText: string;
  parkedAt: string;
  outputPreview: string;
}

class StuckPromptRegistry {
  private parked = new Map<number, ParkedTask>();

  park(entry: Omit<ParkedTask, "parkedAt" | "hardTimer"> & { onAutoAbort: (taskId: number, reason: string) => void }): ParkedTask {
    // If a task is somehow re-parked, clear the old entry first.
    const existing = this.parked.get(entry.taskId);
    if (existing) {
      clearTimeout(existing.hardTimer);
      this.parked.delete(entry.taskId);
    }

    const reason = `No operator input within ${HARD_CEILING_MS / 60_000} minutes — aborted`;
    const hardTimer = setTimeout(() => {
      const live = this.parked.get(entry.taskId);
      if (!live) return;
      this.parked.delete(entry.taskId);
      try { live.abortFn(reason); } catch {}
      try { entry.onAutoAbort(entry.taskId, reason); } catch {}
    }, HARD_CEILING_MS);

    const record: ParkedTask = {
      ...entry,
      parkedAt: new Date(),
      hardTimer,
    };
    this.parked.set(entry.taskId, record);
    return record;
  }

  // Operator submits input — write it to the stream and rearm the idle
  // timer so the post-command idle cycle can complete the run normally.
  // Returns true iff the task was parked (so the caller can return 404).
  provideInput(taskId: number, input: string): boolean {
    const live = this.parked.get(taskId);
    if (!live) return false;
    this.parked.delete(taskId);
    clearTimeout(live.hardTimer);
    try {
      // Newline terminates the prompt response. Most CLIs expect \n;
      // some need \r — \n works on every device we've tested.
      live.stream.write(input + "\n");
    } catch {}
    try { live.resumeIdle(); } catch {}
    return true;
  }

  // Operator-initiated abort — close the SSH stream, mark the task failed.
  abort(taskId: number, reason = "Aborted by operator"): boolean {
    const live = this.parked.get(taskId);
    if (!live) return false;
    this.parked.delete(taskId);
    clearTimeout(live.hardTimer);
    try { live.abortFn(reason); } catch {}
    return true;
  }

  has(taskId: number): boolean {
    return this.parked.has(taskId);
  }

  // Internal cleanup if the SSH session dies on its own while parked
  // (network drop, device reboot, etc).
  forget(taskId: number): void {
    const live = this.parked.get(taskId);
    if (!live) return;
    clearTimeout(live.hardTimer);
    this.parked.delete(taskId);
  }

  list(): PublicParkedTask[] {
    return Array.from(this.parked.values()).map(toPublic);
  }

  listByJob(jobId: number): PublicParkedTask[] {
    return Array.from(this.parked.values())
      .filter((t) => t.jobId === jobId)
      .map(toPublic);
  }

  count(): number {
    return this.parked.size;
  }
}

function toPublic(t: ParkedTask): PublicParkedTask {
  return {
    taskId: t.taskId,
    jobId: t.jobId,
    routerId: t.routerId,
    routerName: t.routerName,
    routerIp: t.routerIp,
    promptText: t.promptText,
    parkedAt: t.parkedAt.toISOString(),
    outputPreview: t.outputPreview,
  };
}

export const stuckPrompts = new StuckPromptRegistry();
