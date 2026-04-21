// ─── Live SSH connection registry ───────────────────────────────────
// Single source of truth for every live SSH connection on this API
// server, regardless of where it was opened from:
//   • "terminal"          — standalone /routers/:id/terminal page
//   • "job-batch"         — auto-confirm batch job (executeSSHCommand)
//   • "job-interactive"   — interactive job (interactive-session.ts)
//
// The admin "Active SSH Sessions" page reads this registry and offers a
// force-disconnect for any entry — useful when a job is hung waiting for
// a wedged device to finish, when an operator left a terminal tab open,
// or when an interactive job is parked but the underlying TCP socket
// has gone half-open and won't drop on its own.
//
// Each registrar (router-terminal.ts, ssh.ts, interactive-session.ts)
// adds itself the moment connectSSH() resolves and removes itself in
// the conn close/error handlers — no central code needs to know about
// the lifecycle of any specific path.

export type ConnectionKind = "terminal" | "job-batch" | "job-interactive";

export interface ConnectionEntry {
  key: string;
  kind: ConnectionKind;
  userId?: number | string;
  username?: string;
  routerId: number;
  routerName: string;
  routerIp: string;
  // Job context — present on job-batch / job-interactive entries.
  jobId?: number;
  jobName?: string;
  taskId?: number;
  openedAt: number;
  lastActivityAt: number;
  // Idempotent disconnect callback. The registrar owns the actual SSH
  // teardown (conn.end(), stream.end(), state cleanup) and must be safe
  // to call even after the connection has already closed naturally.
  close: (reason?: string) => void;
}

export interface PublicConnection {
  key: string;
  kind: ConnectionKind;
  userId: number | string | null;
  username: string | null;
  routerId: number;
  routerName: string;
  routerIp: string;
  jobId: number | null;
  jobName: string | null;
  taskId: number | null;
  openedAt: string;
  lastActivityAt: string;
  ageSeconds: number;
  idleSeconds: number;
}

class SshRegistry {
  private entries = new Map<string, ConnectionEntry>();

  add(entry: ConnectionEntry): void {
    // Defensive: if a stale entry exists under the same key, evict it
    // first so the list view never shows a duplicate.
    this.entries.delete(entry.key);
    this.entries.set(entry.key, entry);
  }

  remove(key: string): void {
    this.entries.delete(key);
  }

  touch(key: string): void {
    const e = this.entries.get(key);
    if (e) e.lastActivityAt = Date.now();
  }

  has(key: string): boolean {
    return this.entries.has(key);
  }

  get(key: string): ConnectionEntry | undefined {
    return this.entries.get(key);
  }

  count(): number {
    return this.entries.size;
  }

  // Force-close by key. Returns true iff the entry existed. The close()
  // callback is responsible for removing itself from the registry via
  // its conn.on("close") handler — but we also remove eagerly here so
  // a follow-up GET reflects the change immediately.
  close(key: string, reason?: string): boolean {
    const e = this.entries.get(key);
    if (!e) return false;
    this.entries.delete(key);
    try { e.close(reason); } catch {}
    return true;
  }

  list(): PublicConnection[] {
    const now = Date.now();
    return Array.from(this.entries.values()).map((e) => ({
      key: e.key,
      kind: e.kind,
      userId: e.userId ?? null,
      username: e.username ?? null,
      routerId: e.routerId,
      routerName: e.routerName,
      routerIp: e.routerIp,
      jobId: e.jobId ?? null,
      jobName: e.jobName ?? null,
      taskId: e.taskId ?? null,
      openedAt: new Date(e.openedAt).toISOString(),
      lastActivityAt: new Date(e.lastActivityAt).toISOString(),
      ageSeconds: Math.round((now - e.openedAt) / 1000),
      idleSeconds: Math.round((now - e.lastActivityAt) / 1000),
    }));
  }
}

export const sshRegistry = new SshRegistry();
