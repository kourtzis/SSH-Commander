import { useState, useEffect, useRef, useCallback } from "react";
import { useParams } from "wouter";
import { useGetJob } from "@workspace/api-client-react";
import { useQuery } from "@tanstack/react-query";
import { useJobsMutations } from "@/hooks/use-mutations";
import { useConfirm } from "@/components/confirm-dialog";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Ban, CheckCircle2, XCircle, PlayCircle, Terminal, Clock,
  ChevronDown, ChevronRight, ScrollText, Code, ShieldCheck,
  MessageSquare, Send, AlertTriangle, Filter, Users
} from "lucide-react";
import { formatDate } from "@/lib/utils";
import { SnippetViewer } from "@/components/snippet-viewer";
import { useToast } from "@/hooks/use-toast";
import { Download } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

// Export job results in CSV / TXT / ZIP. We open the URL via window.location
// (with credentials carried by the cookie) rather than the generated useExportJob
// hook because the response is a binary download, not JSON.
function ExportMenu({ jobId, jobName }: { jobId: number; jobName: string }) {
  const baseUrl = import.meta.env.BASE_URL || "/";
  const apiPrefix = baseUrl.replace(/\/$/, "");
  const handleExport = (format: "csv" | "txt" | "zip") => {
    const url = `${apiPrefix}/api/jobs/${jobId}/export?format=${format}`;
    const link = document.createElement("a");
    link.href = url;
    link.download = `${jobName.replace(/[^a-zA-Z0-9._-]+/g, "_")}.${format}`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" className="gap-2" data-testid="export-menu-trigger">
          <Download className="w-4 h-4" /> Export
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onSelect={() => handleExport("csv")}>CSV (spreadsheet)</DropdownMenuItem>
        <DropdownMenuItem onSelect={() => handleExport("txt")}>TXT (single file)</DropdownMenuItem>
        <DropdownMenuItem onSelect={() => handleExport("zip")}>ZIP (one file per device)</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

interface LiveEvent {
  type: "task_status" | "task_output" | "input_required" | "input_sent" | "job_complete";
  taskId: number;
  routerId?: number;
  routerName?: string;
  routerIp?: string;
  status?: string;
  output?: string;
  promptText?: string;
  promptType?: "confirm" | "input";
  input?: string;
  jobStatus?: string;
  completedTasks?: number;
  failedTasks?: number;
  totalTasks?: number;
}

interface WaitingDevice {
  taskId: number;
  routerId: number;
  routerName: string;
  routerIp: string;
  promptText: string;
  promptType: "confirm" | "input";
}

export default function JobDetail() {
  const { id } = useParams<{ id: string }>();
  const jobId = parseInt(id);
  const { toast } = useToast();
  const confirmDialog = useConfirm();
  const { cancelJob } = useJobsMutations();
  const [expandedTask, setExpandedTask] = useState<number | null>(null);
  const [waitingDevices, setWaitingDevices] = useState<WaitingDevice[]>([]);
  const [liveOutputs, setLiveOutputs] = useState<Map<number, string>>(new Map());
  const [responseText, setResponseText] = useState("");
  const [selectedTaskIds, setSelectedTaskIds] = useState<Set<number>>(new Set());
  const [isSending, setIsSending] = useState(false);
  const [showWaitingFirst, setShowWaitingFirst] = useState(false);
  const [sseConnected, setSseConnected] = useState(false);
  const eventSourceRef = useRef<EventSource | null>(null);
  const responseInputRef = useRef<HTMLInputElement>(null);

  const { data: job, isLoading, refetch } = useGetJob(jobId, {
    query: {
      refetchInterval: (query) => {
        const status = query.state.data?.status;
        return (status === 'running' || status === 'pending') ? 2000 : false;
      }
    }
  });

  // Lazy-fetch the heavyweight per-task fields (output + connectionLog) only
  // when the user expands a task. The polled /jobs/:id response strips these
  // by default so the 2s poll stays small even with many devices / large
  // outputs. While the task is running we keep refetching every 2s to mirror
  // the live SSE-streamed output the user already sees inline.
  //
  // IMPORTANT: this block must come *after* `useGetJob(...)` above, otherwise
  // referencing `job` here trips JavaScript's `const` temporal-dead-zone the
  // moment a user clicks a row (`expandedTask` flips truthy → `job?.tasks…`
  // is evaluated → ReferenceError → React error boundary fires the "Something
  // went wrong" page). Discovered as the v1.8.18 fix.
  const baseUrl = (import.meta.env.BASE_URL || "/").replace(/\/$/, "");
  const expandedTaskStatus = expandedTask
    ? (job?.tasks?.find((t) => t.id === expandedTask)?.status ?? null)
    : null;
  const { data: expandedTaskFull } = useQuery({
    queryKey: ["job-task-full", jobId, expandedTask],
    queryFn: async () => {
      const r = await fetch(`${baseUrl}/api/jobs/${jobId}/tasks/${expandedTask}`, {
        credentials: "include",
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json() as Promise<{ output: string | null; connectionLog: string | null }>;
    },
    enabled: !!expandedTask,
    refetchInterval: expandedTaskStatus === "running" ? 2000 : false,
  });

  useEffect(() => {
    if (!job || job.status !== "running" || job.autoConfirm) return;

    const baseUrl = import.meta.env.BASE_URL || "/";
    const url = `${baseUrl}api/jobs/${jobId}/live`;

    const es = new EventSource(url, { withCredentials: true });
    eventSourceRef.current = es;

    es.onopen = () => setSseConnected(true);
    es.onerror = () => setSseConnected(false);

    es.onmessage = (evt) => {
      try {
        const event: LiveEvent = JSON.parse(evt.data);

        if (event.type === "input_required") {
          setWaitingDevices(prev => {
            const exists = prev.some(d => d.taskId === event.taskId);
            if (exists) return prev;
            return [...prev, {
              taskId: event.taskId,
              routerId: event.routerId!,
              routerName: event.routerName!,
              routerIp: event.routerIp!,
              promptText: event.promptText!,
              promptType: event.promptType ?? "input",
            }];
          });
        }

        if (event.type === "input_sent") {
          setWaitingDevices(prev => prev.filter(d => d.taskId !== event.taskId));
          setSelectedTaskIds(prev => {
            const next = new Set(prev);
            next.delete(event.taskId);
            return next;
          });
        }

        if (event.type === "task_status" && event.status && event.status !== "waiting_input") {
          setWaitingDevices(prev => prev.filter(d => d.taskId !== event.taskId));
        }

        if (event.type === "task_output" && event.output) {
          setLiveOutputs(prev => {
            const next = new Map(prev);
            const existing = next.get(event.taskId) || "";
            next.set(event.taskId, existing + event.output!);
            return next;
          });
        }

        if (event.type === "job_complete") {
          refetch();
          es.close();
          setSseConnected(false);
        }

        if (event.type === "task_status") {
          refetch();
        }
      } catch {}
    };

    return () => {
      es.close();
      setSseConnected(false);
    };
  }, [job?.status, job?.autoConfirm, jobId]);

  const handleCancel = async () => {
    const isRunning = job!.status === "running";
    const ok = await confirmDialog({
      title: isRunning ? "Stop Job" : "Cancel Job",
      description: isRunning ? "Are you sure you want to stop this running job?" : "Are you sure you want to cancel this scheduled job?",
      confirmLabel: isRunning ? "Stop" : "Cancel Job",
      variant: "destructive",
    });
    if (!ok) return;
    try {
      await cancelJob.mutateAsync({ id: jobId });
      toast({ title: "Cancel requested" });
    } catch (e: any) {
      toast({ title: "Failed to cancel", description: e.message, variant: "destructive" });
    }
  };

  const handleSendResponse = async (taskIds: number[]) => {
    if (!responseText.trim()) {
      toast({ title: "Please enter a response", variant: "destructive" });
      return;
    }
    setIsSending(true);
    try {
      const baseUrl = import.meta.env.BASE_URL || "/";
      const res = await fetch(`${baseUrl}api/jobs/${jobId}/respond`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ taskIds, input: responseText.trim() }),
      });
      const data = await res.json();
      if (data.sent?.length > 0) {
        toast({ title: `Response sent to ${data.sent.length} device(s)` });
        setResponseText("");
      }
      if (data.notFound?.length > 0) {
        toast({ title: `${data.notFound.length} device(s) no longer waiting`, variant: "destructive" });
      }
    } catch (e: any) {
      toast({ title: "Failed to send response", description: e.message, variant: "destructive" });
    }
    setIsSending(false);
  };

  const handleSendToSelected = () => {
    if (selectedTaskIds.size === 0) {
      toast({ title: "Select at least one device", variant: "destructive" });
      return;
    }
    handleSendResponse(Array.from(selectedTaskIds));
  };

  const handleSendToAll = () => {
    const allWaitingIds = waitingDevices.map(d => d.taskId);
    handleSendResponse(allWaitingIds);
  };

  const toggleTaskSelection = (taskId: number) => {
    setSelectedTaskIds(prev => {
      const next = new Set(prev);
      if (next.has(taskId)) next.delete(taskId);
      else next.add(taskId);
      return next;
    });
  };

  const toggleSelectAll = () => {
    const allIds = waitingDevices.map(d => d.taskId);
    const allSelected = allIds.every(id => selectedTaskIds.has(id));
    if (allSelected) {
      setSelectedTaskIds(new Set());
    } else {
      setSelectedTaskIds(new Set(allIds));
    }
  };

  const toggleTask = (taskId: number) => {
    setExpandedTask(expandedTask === taskId ? null : taskId);
  };

  if (isLoading) return <div className="p-8 text-center text-muted-foreground">Loading job details...</div>;
  if (!job) return <div className="p-8 text-center text-destructive">Job not found.</div>;

  const doneTasks = job.completedTasks + job.failedTasks;
  const remainingTasks = job.totalTasks - doneTasks;
  const progress = job.totalTasks > 0 ? (doneTasks / job.totalTasks) * 100 : 0;

  const waitingCount = waitingDevices.length;
  const isInteractive = job.status === "running" && !job.autoConfirm;

  const sortedTasks = showWaitingFirst
    ? [...job.tasks].sort((a, b) => {
        const aWaiting = waitingDevices.some(w => w.taskId === a.id) ? 0 : 1;
        const bWaiting = waitingDevices.some(w => w.taskId === b.id) ? 0 : 1;
        return aWaiting - bWaiting;
      })
    : job.tasks;

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-3">
            <h1 className="text-3xl font-bold tracking-tight">{job.name}</h1>
            <Badge variant={
              job.status === 'running' ? 'default' :
              job.status === 'scheduled' ? 'outline' :
              job.status === 'cancelled' ? 'secondary' :
              job.status === 'completed' && job.failedTasks > 0 && job.completedTasks > 0 ? 'warning' :
              job.status === 'completed' && job.failedTasks > 0 ? 'destructive' :
              job.status === 'completed' ? 'success' :
              job.status === 'failed' ? 'destructive' : 'secondary'
            } className="text-sm px-3 py-1">
              {job.status === 'running' && <PlayCircle className="w-4 h-4 mr-1 animate-pulse" />}
              {job.status === 'completed' && <CheckCircle2 className="w-4 h-4 mr-1" />}
              {job.status === 'failed' && <XCircle className="w-4 h-4 mr-1" />}
              {job.status === 'cancelled' && <Ban className="w-4 h-4 mr-1" />}
              {job.status === 'scheduled' && <Clock className="w-4 h-4 mr-1" />}
              {job.status === 'running' ? 'Running' :
               job.status === 'scheduled' ? 'Scheduled' :
               job.status === 'cancelled' ? 'Stopped' :
               job.status === 'completed' && job.failedTasks > 0 && job.completedTasks > 0 ? 'Partially Successful' :
               job.status === 'completed' && job.failedTasks > 0 ? 'Failed' :
               job.status === 'completed' ? 'Successful' :
               job.status === 'failed' ? 'Failed' : job.status}
            </Badge>
            {isInteractive && sseConnected && (
              <Badge variant="outline" className="text-xs gap-1 border-emerald-500/30 text-emerald-400">
                <div className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
                Live
              </Badge>
            )}
          </div>
          <p className="text-muted-foreground mt-2 flex items-center gap-2 flex-wrap">
            <Clock className="w-4 h-4" /> Started {formatDate(job.createdAt)}
            {job.completedAt && ` • Finished ${formatDate(job.completedAt)}`}
            {job.autoConfirm && <Badge variant="outline" className="ml-2 text-xs gap-1"><ShieldCheck className="w-3 h-3" />Auto-confirm</Badge>}
            {!job.autoConfirm && <Badge variant="outline" className="ml-2 text-xs gap-1 border-amber-500/30 text-amber-400"><MessageSquare className="w-3 h-3" />Interactive</Badge>}
            {(job as any).timeoutSeconds && (
              <Badge variant="outline" className="ml-1 text-xs gap-1">
                <Clock className="w-3 h-3" /> Timeout {(job as any).timeoutSeconds}s
              </Badge>
            )}
            {((job as any).retryCount ?? 0) > 0 && (
              <Badge variant="outline" className="ml-1 text-xs gap-1 border-blue-500/30 text-blue-400">
                Retries: {(job as any).retryCount} (back-off {(job as any).retryBackoffSeconds ?? 5}s)
              </Badge>
            )}
          </p>
        </div>
        
        <div className="flex items-center gap-2">
          {(job.status === "completed" || job.status === "failed") && (
            <ExportMenu jobId={job.id} jobName={job.name} />
          )}
          {(job.status === 'running' || job.status === 'scheduled') && (
            <Button variant="destructive" onClick={handleCancel} className="gap-2 shadow-[0_0_15px_rgba(220,38,38,0.3)]">
              <Ban className="w-4 h-4" /> {job.status === 'running' ? 'Stop Job' : 'Cancel Job'}
            </Button>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <Card className="glass-panel lg:col-span-1">
          <CardHeader>
            <CardTitle className="text-xl">Execution Progress</CardTitle>
          </CardHeader>
          <CardContent className="space-y-6">
            <div>
              <div className="flex justify-between text-sm mb-2 font-medium">
                <span>{doneTasks} / {job.totalTasks} done</span>
                <span>{Math.round(progress)}%</span>
              </div>
              <div className="w-full h-3 bg-black/40 rounded-full overflow-hidden border border-white/5">
                <div 
                  className="h-full bg-primary transition-all duration-500 ease-out relative" 
                  style={{ width: `${progress}%` }}
                >
                  {job.status === "running" && <div className="absolute inset-0 bg-white/20 animate-pulse" />}
                </div>
              </div>
              {job.status === "running" && remainingTasks > 0 && (
                <p className="text-xs text-muted-foreground mt-2 animate-pulse">
                  Executing... {remainingTasks} device{remainingTasks !== 1 ? "s" : ""} remaining
                </p>
              )}
            </div>

            <div className="grid grid-cols-3 gap-3">
              <div className="p-4 rounded-xl bg-black/20 border border-white/5 text-center">
                <p className="text-2xl font-bold text-emerald-400">{job.completedTasks}</p>
                <p className="text-xs text-muted-foreground uppercase font-semibold mt-1">Success</p>
              </div>
              <div className="p-4 rounded-xl bg-black/20 border border-white/5 text-center">
                <p className="text-2xl font-bold text-destructive">{job.failedTasks}</p>
                <p className="text-xs text-muted-foreground uppercase font-semibold mt-1">Failed</p>
              </div>
              <div className="p-4 rounded-xl bg-black/20 border border-white/5 text-center">
                <p className="text-2xl font-bold text-yellow-400">{remainingTasks}</p>
                <p className="text-xs text-muted-foreground uppercase font-semibold mt-1">Remaining</p>
              </div>
              {waitingCount > 0 && (
                <div className="p-4 rounded-xl bg-amber-500/10 border border-amber-500/20 text-center col-span-3">
                  <p className="text-2xl font-bold text-amber-400">{waitingCount}</p>
                  <p className="text-xs text-amber-400/70 uppercase font-semibold mt-1">Waiting for Input</p>
                </div>
              )}
              <div className="p-4 rounded-xl bg-black/20 border border-white/5 text-center col-span-3">
                <p className="text-3xl font-display font-bold">{job.totalTasks}</p>
                <p className="text-xs text-muted-foreground uppercase font-semibold mt-1">Total Targets</p>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card className="glass-panel lg:col-span-2">
          <CardHeader>
            <CardTitle className="text-xl flex items-center gap-2">
              <Terminal className="w-5 h-5 text-primary" /> Source Script
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="max-h-64 overflow-y-auto rounded-xl">
              <SnippetViewer code={job.scriptCode} />
            </div>
          </CardContent>
        </Card>
      </div>

      {waitingCount > 0 && (
        <Card className="glass-panel border-amber-500/30 shadow-[0_0_20px_rgba(245,158,11,0.1)]">
          <CardHeader className="pb-3">
            <CardTitle className="text-xl flex items-center gap-2 text-amber-400">
              <AlertTriangle className="w-5 h-5" />
              {waitingCount} Device{waitingCount !== 1 ? "s" : ""} Waiting for Input
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="rounded-xl border border-amber-500/20 overflow-hidden">
              <div className="flex items-center gap-3 px-4 py-2 bg-amber-500/10 border-b border-amber-500/20">
                <Checkbox
                  checked={waitingDevices.length > 0 && waitingDevices.every(d => selectedTaskIds.has(d.taskId))}
                  onCheckedChange={toggleSelectAll}
                  className="border-amber-500/50"
                />
                <span className="text-xs font-semibold uppercase text-amber-400/70">Select All</span>
              </div>
              {waitingDevices.map(dev => (
                <div
                  key={dev.taskId}
                  className="flex items-start gap-3 px-4 py-3 border-b border-amber-500/10 last:border-b-0 hover:bg-amber-500/5 transition-colors"
                >
                  <Checkbox
                    checked={selectedTaskIds.has(dev.taskId)}
                    onCheckedChange={() => toggleTaskSelection(dev.taskId)}
                    className="mt-0.5 border-amber-500/50"
                  />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-medium text-sm">{dev.routerName}</span>
                      <span className="text-xs text-muted-foreground font-mono">{dev.routerIp}</span>
                      <Badge variant="outline" className="text-[10px] px-1.5 py-0 border-amber-500/30 text-amber-400">
                        {dev.promptType === "confirm" ? "Yes/No" : "Input"}
                      </Badge>
                    </div>
                    <pre className="text-xs text-amber-300/80 font-mono mt-1 bg-black/30 px-2 py-1 rounded whitespace-pre-wrap">{dev.promptText}</pre>
                  </div>
                </div>
              ))}
            </div>

            <div className="flex gap-2 items-center">
              <Input
                ref={responseInputRef}
                placeholder="Type your response..."
                value={responseText}
                onChange={e => setResponseText(e.target.value)}
                onKeyDown={e => {
                  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleSendToAll(); }
                  if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); handleSendToAll(); }
                }}
                className="flex-1 bg-black/30 border-amber-500/20 focus-visible:ring-amber-500/50"
              />
              <Button
                size="sm"
                variant="outline"
                onClick={handleSendToSelected}
                disabled={isSending || selectedTaskIds.size === 0}
                className="gap-1 border-amber-500/30 text-amber-400 hover:bg-amber-500/10 whitespace-nowrap"
              >
                <Send className="w-3.5 h-3.5" />
                Send to Selected ({selectedTaskIds.size})
              </Button>
              <Button
                size="sm"
                onClick={handleSendToAll}
                disabled={isSending || waitingCount === 0}
                className="gap-1 bg-amber-500 hover:bg-amber-600 text-black whitespace-nowrap"
              >
                <Users className="w-3.5 h-3.5" />
                Send to All ({waitingCount})
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      <Card className="glass-panel overflow-hidden">
        <div className="p-6 border-b border-border/50 bg-black/20 flex items-center justify-between">
          <div>
            <CardTitle className="text-xl">Task Results</CardTitle>
            <p className="text-xs text-muted-foreground mt-1">Click a row to view its SSH connection log and resolved script</p>
          </div>
          {waitingCount > 0 && (
            <Button
              size="sm"
              variant={showWaitingFirst ? "default" : "outline"}
              onClick={() => setShowWaitingFirst(!showWaitingFirst)}
              className="gap-1.5 text-xs"
            >
              <Filter className="w-3.5 h-3.5" />
              {showWaitingFirst ? "Showing waiting first" : "Group waiting"}
            </Button>
          )}
        </div>
        <CardContent className="p-0">
          {job.tasks.length === 0 ? (
            <div className="p-8 text-center text-muted-foreground">No tasks generated for this job.</div>
          ) : (
            <div>
              {sortedTasks.map(task => {
                const isExpanded = expandedTask === task.id;
                const isWaiting = waitingDevices.some(w => w.taskId === task.id);
                const waitingInfo = waitingDevices.find(w => w.taskId === task.id);
                const liveOutput = liveOutputs.get(task.id);
                // task.output is null in the polled response — fall back to
                // the lazy-fetched full payload when this task is expanded.
                const fullOutput = isExpanded ? expandedTaskFull?.output : null;
                const displayOutput = liveOutput || fullOutput || task.output;
                const fullConnectionLog = isExpanded ? expandedTaskFull?.connectionLog : null;
                const taskStatus = isWaiting ? "waiting_input" : task.status;

                return (
                  <div key={task.id} className={`border-b border-border/50 last:border-b-0 ${isWaiting ? "bg-amber-500/5" : ""}`}>
                    <div
                      className="flex items-center gap-4 px-6 py-4 cursor-pointer hover:bg-white/5 transition-colors select-none"
                      onClick={() => toggleTask(task.id)}
                    >
                      <div className="text-muted-foreground shrink-0">
                        {isExpanded ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
                      </div>
                      <div className="shrink-0">
                        <Badge variant={
                          taskStatus === 'waiting_input' ? 'warning' :
                          taskStatus === 'success' ? 'success' : 
                          taskStatus === 'failed' ? 'destructive' : 
                          taskStatus === 'running' ? 'default' : 'secondary'
                        } className="capitalize">
                          {taskStatus === 'running' && <PlayCircle className="w-3 h-3 mr-1 animate-pulse" />}
                          {taskStatus === 'success' && <CheckCircle2 className="w-3 h-3 mr-1" />}
                          {taskStatus === 'failed' && <XCircle className="w-3 h-3 mr-1" />}
                          {taskStatus === 'waiting_input' && <MessageSquare className="w-3 h-3 mr-1 animate-pulse" />}
                          {taskStatus === 'waiting_input' ? 'Awaiting Input' : taskStatus}
                        </Badge>
                      </div>
                      <div className="flex-1 min-w-0">
                        <span className="font-medium text-sm text-foreground">{task.routerName}</span>
                        <span className="text-xs text-muted-foreground font-mono ml-2">{task.routerIp}</span>
                        {((task as any).attemptCount ?? 1) > 1 && (
                          <Badge variant="outline" className="ml-2 text-[10px] border-blue-500/30 text-blue-400">
                            Retried {((task as any).attemptCount as number) - 1}×
                          </Badge>
                        )}
                      </div>
                      {isWaiting && waitingInfo && (
                        <div className="shrink-0">
                          <Badge variant="outline" className="text-[10px] border-amber-500/30 text-amber-400 animate-pulse">
                            {waitingInfo.promptType === "confirm" ? "Yes/No prompt" : "Input prompt"}
                          </Badge>
                        </div>
                      )}
                      <div className="text-xs text-muted-foreground whitespace-nowrap shrink-0">
                        {task.startedAt && task.completedAt ? (
                          <span>{Math.round((new Date(task.completedAt).getTime() - new Date(task.startedAt).getTime()) / 1000)}s</span>
                        ) : taskStatus === 'running' ? (
                          <span className="animate-pulse">running...</span>
                        ) : taskStatus === 'waiting_input' ? (
                          <span className="text-amber-400 animate-pulse">waiting...</span>
                        ) : taskStatus === 'pending' ? (
                          <span>waiting</span>
                        ) : '-'}
                      </div>
                      <div className="shrink-0 max-w-xs truncate">
                        {task.errorMessage ? (
                          <span className="text-xs text-destructive truncate">{task.errorMessage}</span>
                        ) : displayOutput ? (
                          <span className="text-xs text-emerald-400 truncate">{displayOutput.slice(0, 60)}{displayOutput.length > 60 ? "..." : ""}</span>
                        ) : null}
                      </div>
                    </div>

                    {isExpanded && (
                      <div className="px-6 pb-6 pt-2 bg-black/20 space-y-4 border-t border-white/5">
                        {isWaiting && waitingInfo && (
                          <div className="p-4 rounded-xl bg-amber-500/10 border border-amber-500/20">
                            <div className="flex items-center gap-2 mb-2">
                              <AlertTriangle className="w-3.5 h-3.5 text-amber-400" />
                              <span className="text-xs font-semibold uppercase text-amber-400">Waiting for Input</span>
                            </div>
                            <pre className="text-xs font-mono text-amber-300/80 bg-black/30 p-3 rounded-lg whitespace-pre-wrap mb-3">{waitingInfo.promptText}</pre>
                            <div className="flex gap-2">
                              <Input
                                placeholder="Type response..."
                                value={responseText}
                                onChange={e => setResponseText(e.target.value)}
                                onKeyDown={e => {
                                  if (e.key === "Enter") {
                                    e.preventDefault();
                                    handleSendResponse([task.id]);
                                  }
                                }}
                                className="flex-1 h-8 text-sm bg-black/30 border-amber-500/20"
                              />
                              <Button
                                size="sm"
                                onClick={() => handleSendResponse([task.id])}
                                disabled={isSending}
                                className="gap-1 h-8 bg-amber-500 hover:bg-amber-600 text-black"
                              >
                                <Send className="w-3 h-3" /> Send
                              </Button>
                            </div>
                          </div>
                        )}

                        {displayOutput && (
                          <div>
                            <div className="flex items-center gap-2 mb-2">
                              <Terminal className="w-3.5 h-3.5 text-emerald-400" />
                              <span className="text-xs font-semibold uppercase text-emerald-400">Output</span>
                              {liveOutput && task.status === "running" && (
                                <Badge variant="outline" className="text-[10px] border-emerald-500/30 text-emerald-400 animate-pulse ml-1">Live</Badge>
                              )}
                            </div>
                            <pre className="text-xs font-mono text-emerald-400 bg-black/40 p-4 rounded-xl border border-white/5 overflow-x-auto whitespace-pre-wrap max-h-48 overflow-y-auto">{displayOutput}</pre>
                          </div>
                        )}

                        {task.errorMessage && (
                          <div>
                            <div className="flex items-center gap-2 mb-2">
                              <XCircle className="w-3.5 h-3.5 text-destructive" />
                              <span className="text-xs font-semibold uppercase text-destructive">Error</span>
                            </div>
                            <pre className="text-xs font-mono text-destructive bg-destructive/10 p-4 rounded-xl border border-destructive/20 overflow-x-auto whitespace-pre-wrap">{task.errorMessage}</pre>
                          </div>
                        )}

                        {(task as any).resolvedScript && (
                          <div>
                            <div className="flex items-center gap-2 mb-2">
                              <Code className="w-3.5 h-3.5 text-blue-400" />
                              <span className="text-xs font-semibold uppercase text-blue-400">Resolved Script (after tag substitution)</span>
                            </div>
                            <pre className="text-xs font-mono text-blue-300 bg-black/40 p-4 rounded-xl border border-blue-500/20 overflow-x-auto whitespace-pre-wrap max-h-48 overflow-y-auto">{(task as any).resolvedScript}</pre>
                          </div>
                        )}

                        {fullConnectionLog && (
                          <div>
                            <div className="flex items-center gap-2 mb-2">
                              <ScrollText className="w-3.5 h-3.5 text-yellow-400" />
                              <span className="text-xs font-semibold uppercase text-yellow-400">SSH Connection Log</span>
                            </div>
                            <pre className="text-xs font-mono text-muted-foreground bg-black/60 p-4 rounded-xl border border-yellow-500/20 overflow-x-auto whitespace-pre-wrap max-h-64 overflow-y-auto leading-relaxed">{fullConnectionLog}</pre>
                          </div>
                        )}

                        {!displayOutput && !task.errorMessage && !fullConnectionLog && !(task as any).resolvedScript && !isWaiting && (
                          <p className="text-xs text-muted-foreground italic">No log data available yet for this task.</p>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
