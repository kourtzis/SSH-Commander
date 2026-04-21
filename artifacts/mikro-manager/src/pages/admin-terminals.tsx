// ─── Admin: Active SSH Sessions ───────────────────────────────────
// Lists every live SSH session running on the API server, regardless
// of where it was opened from:
//   • terminal         — standalone /routers/:id/terminal page
//   • job-batch        — auto-confirm batch job task
//   • job-interactive  — interactive job task
//
// Lets an admin force-disconnect any session — useful when one wedges
// (device stops responding but TCP socket stays half-open), when an
// operator forgets to close a tab, or when a parked interactive job
// needs to be killed at the socket level.
//
// The data is in-memory on the API server (not persisted), so this is
// a "right now" view — sessions disappear from the list the moment they
// close, whether by user action, idle/global timeout, or admin kill.

import { useEffect, useState, useCallback } from "react";
import { Link } from "wouter";
import { customFetch } from "@workspace/api-client-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Terminal as TerminalIcon, RefreshCw, X, ArrowLeft } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

type SessionKind = "terminal" | "job-batch" | "job-interactive";

interface ActiveSession {
  key: string;
  kind: SessionKind;
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

interface ListResponse {
  sessions: ActiveSession[];
  idleLimitSeconds: number;
  maxLifetimeSeconds: number;
}

function fmtDuration(totalSeconds: number): string {
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  if (m < 60) return `${m}m ${s}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

const KIND_LABEL: Record<SessionKind, string> = {
  "terminal": "Terminal",
  "job-batch": "Batch job",
  "job-interactive": "Interactive job",
};

const KIND_CLASS: Record<SessionKind, string> = {
  "terminal": "bg-primary/15 text-primary border-primary/30",
  "job-batch": "bg-blue-500/15 text-blue-300 border-blue-500/30",
  "job-interactive": "bg-amber-500/15 text-amber-300 border-amber-500/30",
};

export default function AdminTerminals() {
  const { toast } = useToast();
  const [data, setData] = useState<ListResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const baseUrl = import.meta.env.BASE_URL || "/";

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const json = await customFetch<ListResponse>(`${baseUrl}api/admin/terminals`, { credentials: "include" });
      setData(json);
    } catch (err: any) {
      setError(String(err?.message || err));
    } finally {
      setLoading(false);
    }
  }, [baseUrl]);

  useEffect(() => {
    load();
    // Auto-refresh every 5s so the list reflects new connects/disconnects
    // without making the operator click Refresh constantly.
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, [load]);

  const disconnect = async (key: string, label: string) => {
    if (!confirm(`Force-disconnect SSH session "${label}"?\n\nThis severs the underlying socket. For a job task this will mark the task as failed.`)) return;
    try {
      const json = await customFetch<{ message?: string }>(`${baseUrl}api/admin/terminals/${encodeURIComponent(key)}`, {
        method: "DELETE",
        credentials: "include",
      });
      toast({ title: "Session closed", description: json?.message || `Closed ${label}` });
      load();
    } catch (err: any) {
      toast({ title: "Failed to close session", description: String(err?.message || err), variant: "destructive" });
    }
  };

  const sessions = data?.sessions ?? [];

  return (
    <div className="space-y-6">
      <div>
        <Link href="/routers">
          <button className="text-xs text-muted-foreground hover:text-foreground inline-flex items-center gap-1 mb-2">
            <ArrowLeft className="w-3 h-3" /> back to devices
          </button>
        </Link>
        <h1 className="text-3xl font-bold tracking-tight flex items-center gap-3">
          <TerminalIcon className="w-7 h-7 text-primary" />
          Active SSH Sessions
        </h1>
        <p className="text-muted-foreground mt-1 text-sm">
          Live, in-memory list of every SSH connection on the API server — standalone terminals, batch jobs, and interactive jobs.
          {data && (
            <>
              {" "}Standalone terminals auto-close after <strong>{Math.round(data.idleLimitSeconds / 60)} min</strong> idle or <strong>{Math.round(data.maxLifetimeSeconds / 60)} min</strong> total.
            </>
          )}
        </p>
      </div>

      <Card>
        <CardContent className="p-0">
          <div className="flex items-center justify-between px-4 py-3 border-b border-white/5">
            <div className="text-sm text-muted-foreground">
              {sessions.length} active session{sessions.length === 1 ? "" : "s"}
              {error && <span className="ml-3 text-destructive">· {error}</span>}
            </div>
            <Button variant="outline" size="sm" onClick={load} disabled={loading} className="gap-2" data-testid="refresh-button">
              <RefreshCw className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`} /> Refresh
            </Button>
          </div>
          {sessions.length === 0 ? (
            <div className="p-12 text-center text-sm text-muted-foreground">
              No SSH sessions are currently open.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-left text-xs uppercase text-muted-foreground border-b border-white/5">
                  <tr>
                    <th className="px-4 py-2 font-medium">Kind</th>
                    <th className="px-4 py-2 font-medium">User / Job</th>
                    <th className="px-4 py-2 font-medium">Device</th>
                    <th className="px-4 py-2 font-medium">Opened</th>
                    <th className="px-4 py-2 font-medium">Idle</th>
                    <th className="px-4 py-2 font-medium text-right">Action</th>
                  </tr>
                </thead>
                <tbody>
                  {sessions.map((s) => (
                    <tr key={s.key} className="border-b border-white/5 hover:bg-white/5">
                      <td className="px-4 py-3">
                        <span className={`inline-block px-2 py-0.5 rounded-md text-[11px] border ${KIND_CLASS[s.kind] ?? "bg-muted/30 text-muted-foreground border-white/10"}`}>
                          {KIND_LABEL[s.kind] ?? s.kind}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-xs">
                        {s.kind === "terminal" ? (
                          <span className="font-mono">{s.username ?? "—"}</span>
                        ) : s.jobId != null ? (
                          <Link href={`/jobs/${s.jobId}`}>
                            <a className="hover:text-primary font-mono text-primary/80">job #{s.jobId}</a>
                          </Link>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        <Link href={`/routers/${s.routerId}`}>
                          <a className="hover:text-primary">
                            <div className="font-medium">{s.routerName}</div>
                            <div className="text-xs text-muted-foreground font-mono">{s.routerIp}</div>
                          </a>
                        </Link>
                      </td>
                      <td className="px-4 py-3 text-muted-foreground">
                        <div>{fmtDuration(s.ageSeconds)} ago</div>
                        <div className="text-xs">{new Date(s.openedAt).toLocaleTimeString()}</div>
                      </td>
                      <td className={`px-4 py-3 ${s.idleSeconds > 300 ? "text-amber-400" : "text-muted-foreground"}`}>
                        {fmtDuration(s.idleSeconds)}
                      </td>
                      <td className="px-4 py-3 text-right">
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => disconnect(s.key, `${KIND_LABEL[s.kind]} → ${s.routerName}`)}
                          className="gap-2 text-red-400 hover:text-red-300 hover:bg-red-500/10"
                          data-testid={`disconnect-${s.key}`}
                        >
                          <X className="w-3.5 h-3.5" /> Disconnect
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
