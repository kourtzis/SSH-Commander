import { useState, useMemo } from "react";
import { useListJobs, useListSchedules, useSearchJobOutputs, getSearchJobOutputsQueryKey } from "@workspace/api-client-react";
import { Link, useLocation } from "wouter";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Skeleton } from "@/components/ui/skeleton";
import { Plus, PlaySquare, CheckCircle2, XCircle, PlayCircle, Ban, Play, Copy, Pencil, Clock, Square, Timer, Search, Loader2, X } from "lucide-react";
import { Input } from "@/components/ui/input";
import { formatDate } from "@/lib/utils";
import { useJobsMutations } from "@/hooks/use-mutations";
import { useConfirm } from "@/components/confirm-dialog";
import { useToast } from "@/hooks/use-toast";
import { useSelection } from "@/hooks/use-selection";
import { SelectionBar } from "@/components/selection-bar";
import { FilterSortBar, ActiveSort, applySort } from "@/components/filter-sort-bar";

function formatDuration(startStr: string, endStr: string | null | undefined): string {
  const start = new Date(startStr).getTime();
  const end = endStr ? new Date(endStr).getTime() : Date.now();
  const diffMs = Math.max(0, end - start);

  const seconds = Math.floor(diffMs / 1000);
  if (seconds < 60) return `${seconds}s`;

  const minutes = Math.floor(seconds / 60);
  const remSec = seconds % 60;
  if (minutes < 60) return `${minutes}m ${remSec}s`;

  const hours = Math.floor(minutes / 60);
  const remMin = minutes % 60;
  return `${hours}h ${remMin}m`;
}

export default function JobsList() {
  const { data: jobs = [], isLoading } = useListJobs();
  const { data: schedules = [] } = useListSchedules();
  const [, setLocation] = useLocation();
  const { rerunJob, cancelJob, deleteJob } = useJobsMutations();
  const { toast } = useToast();
  const confirmDialog = useConfirm();
  const [isBulkDeleting, setIsBulkDeleting] = useState(false);
  const [search, setSearch] = useState("");
  const [filterStatus, setFilterStatus] = useState("");
  const [sort, setSort] = useState<ActiveSort>({ key: "date", dir: "desc" });
  // Fleet-wide device-output search (server-side, spans all visible jobs).
  // Submitted on Enter/button — not per keystroke — because each query is
  // a trigram-index scan over potentially millions of output rows.
  const [outputQ, setOutputQ] = useState("");
  const [submittedQ, setSubmittedQ] = useState("");
  const outputSearchActive = submittedQ.trim().length >= 2;
  const { data: outputHits, isFetching: isSearchingOutputs } = useSearchJobOutputs(
    { q: submittedQ, limit: 50 },
    { query: { queryKey: getSearchJobOutputsQueryKey({ q: submittedQ, limit: 50 }), enabled: outputSearchActive } },
  );

  const sortedJobs = useMemo(() => {
    let result = jobs.filter(j => {
      const matchesSearch = !search ||
        j.name.toLowerCase().includes(search.toLowerCase());
      const matchesStatus = !filterStatus || j.status === filterStatus;
      return matchesSearch && matchesStatus;
    });
    return applySort(result, sort, {
      name: (j) => j.name,
      date: (j) => new Date(j.createdAt),
      status: (j) => j.status,
    });
  }, [jobs, search, filterStatus, sort]);

  const selection = useSelection(sortedJobs.map(j => j.id));

  const getDisplayStatus = (job: { status: string; completedTasks: number; failedTasks: number; totalTasks: number }) => {
    switch (job.status) {
      case 'running': return { label: 'Running', icon: <PlayCircle className="w-4 h-4 mr-1.5 animate-pulse" />, variant: 'default' };
      case 'scheduled': return { label: 'Scheduled', icon: <Clock className="w-4 h-4 mr-1.5" />, variant: 'outline' };
      case 'cancelled': return { label: 'Stopped', icon: <Ban className="w-4 h-4 mr-1.5" />, variant: 'secondary' };
      case 'completed': {
        if (job.failedTasks > 0 && job.completedTasks > 0) {
          return { label: 'Partially Successful', icon: <CheckCircle2 className="w-4 h-4 mr-1.5" />, variant: 'warning' };
        }
        if (job.failedTasks > 0 && job.completedTasks === 0) {
          return { label: 'Failed', icon: <XCircle className="w-4 h-4 mr-1.5" />, variant: 'destructive' };
        }
        return { label: 'Successful', icon: <CheckCircle2 className="w-4 h-4 mr-1.5" />, variant: 'success' };
      }
      case 'failed': return { label: 'Failed', icon: <XCircle className="w-4 h-4 mr-1.5" />, variant: 'destructive' };
      default: return { label: job.status, icon: null, variant: 'outline' };
    }
  };

  const handleRerun = async (e: React.MouseEvent, jobId: number) => {
    e.preventDefault();
    e.stopPropagation();
    try {
      const newJob = await rerunJob.mutateAsync({ id: jobId });
      toast({ title: "Job started!" });
      setLocation(`/jobs/${newJob.id}`);
    } catch (err: any) {
      toast({ title: "Failed to re-run job", description: err.message, variant: "destructive" });
    }
  };

  const handleCopyToNew = (e: React.MouseEvent, jobId: number) => {
    e.preventDefault();
    e.stopPropagation();
    setLocation(`/jobs/new?copyFrom=${jobId}`);
  };

  const handleEdit = (e: React.MouseEvent, jobId: number) => {
    e.preventDefault();
    e.stopPropagation();
    setLocation(`/jobs/new?edit=${jobId}`);
  };

  const handleCancel = async (e: React.MouseEvent, jobId: number, status: string) => {
    e.preventDefault();
    e.stopPropagation();
    const message = status === "running" ? "stop this running job" : "cancel this scheduled job";
    const ok = await confirmDialog({ title: status === "running" ? "Stop Job" : "Cancel Job", description: `Are you sure you want to ${message}?`, confirmLabel: status === "running" ? "Stop" : "Cancel Job", variant: "destructive" });
    if (!ok) return;
    try {
      await cancelJob.mutateAsync({ id: jobId });
      toast({ title: status === "running" ? "Job stopped" : "Job cancelled" });
    } catch (err: any) {
      toast({ title: "Failed to cancel job", description: err.message, variant: "destructive" });
    }
  };

  const handleBulkDelete = async () => {
    // Count schedules that reference any of the selected jobs — these cascade-delete on the server
    const selectedIdSet = new Set(selection.ids);
    const affectedSchedules = schedules.filter(s => selectedIdSet.has(s.jobId)).length;
    const cascadeNote = affectedSchedules > 0
      ? ` This will also remove ${affectedSchedules} schedule${affectedSchedules === 1 ? "" : "s"} that reference ${affectedSchedules === 1 ? "one of these jobs" : "these jobs"}.`
      : "";
    const ok = await confirmDialog({
      title: "Delete Jobs",
      description: `Delete ${selection.count} selected job(s)? This action cannot be undone.${cascadeNote}`,
      confirmLabel: "Delete All",
      variant: "destructive",
    });
    if (!ok) return;
    setIsBulkDeleting(true);
    try {
      await Promise.all(selection.ids.map(id => deleteJob.mutateAsync({ id })));
      const scheduleNote = affectedSchedules > 0 ? ` (and ${affectedSchedules} linked schedule${affectedSchedules === 1 ? "" : "s"})` : "";
      toast({ title: `${selection.count} job(s) deleted${scheduleNote}` });
      selection.clear();
    } catch (err: any) {
      toast({ title: "Error deleting jobs", description: err.message, variant: "destructive" });
    } finally {
      setIsBulkDeleting(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Batch Jobs</h1>
          <p className="text-muted-foreground mt-1">Run and monitor scripts across multiple routers.</p>
        </div>
        <Link href="/jobs/new">
          <Button className="gap-2">
            <Plus className="w-4 h-4" /> New Job
          </Button>
        </Link>
      </div>

      <FilterSortBar
        searchValue={search}
        onSearchChange={setSearch}
        searchPlaceholder="Search jobs by name..."
        filters={[
          {
            key: "status",
            label: "Status",
            type: "select",
            options: [
              { value: "running", label: "Running" },
              { value: "completed", label: "Completed" },
              { value: "failed", label: "Failed" },
              { value: "cancelled", label: "Stopped" },
              { value: "scheduled", label: "Scheduled" },
            ],
          },
        ]}
        activeFilters={{ status: filterStatus }}
        onFilterChange={(key, value) => {
          if (key === "status") setFilterStatus(value as string);
        }}
        sortOptions={[
          { key: "name", label: "Name" },
          { key: "date", label: "Date" },
          { key: "status", label: "Status" },
        ]}
        activeSort={sort}
        onSortChange={setSort}
      />

      <Card className="glass-panel">
        <CardContent className="p-4 space-y-3">
          <form
            onSubmit={(e) => { e.preventDefault(); setSubmittedQ(outputQ); }}
            className="flex flex-col sm:flex-row gap-2"
          >
            <div className="relative flex-1">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
              <Input
                value={outputQ}
                onChange={(e) => setOutputQ(e.target.value)}
                placeholder='Search device outputs across all jobs — e.g. "unreachable", an interface name, a firmware version…'
                className="pl-9 bg-black/30"
                data-testid="input-output-search"
              />
            </div>
            <div className="flex gap-2">
              <Button type="submit" variant="outline" disabled={outputQ.trim().length < 2} className="gap-1.5" data-testid="button-output-search">
                {isSearchingOutputs ? <Loader2 className="w-4 h-4 animate-spin" /> : <Search className="w-4 h-4" />}
                Search outputs
              </Button>
              {outputSearchActive && (
                <Button type="button" variant="ghost" onClick={() => { setOutputQ(""); setSubmittedQ(""); }} className="gap-1">
                  <X className="w-4 h-4" /> Clear
                </Button>
              )}
            </div>
          </form>
          {outputSearchActive && !isSearchingOutputs && (
            <div className="space-y-1">
              <p className="text-xs text-muted-foreground">
                {outputHits?.total ?? 0} matching device output{(outputHits?.total ?? 0) !== 1 ? "s" : ""}
                {(outputHits?.total ?? 0) > (outputHits?.items?.length ?? 0) ? ` (showing first ${outputHits?.items?.length})` : ""}
              </p>
              <div className="divide-y divide-border/50 max-h-96 overflow-y-auto rounded-xl border border-border/50">
                {(outputHits?.items ?? []).map((hit) => (
                  <Link key={hit.taskId} href={`/jobs/${hit.jobId}`} className="block px-4 py-3 hover:bg-white/5 transition-colors">
                    <div className="flex items-center gap-2 flex-wrap mb-1">
                      <span className="text-sm font-medium text-primary">{hit.jobName}</span>
                      <span className="text-xs text-foreground">{hit.routerName}</span>
                      {hit.routerIp && <span className="text-xs text-muted-foreground font-mono">{hit.routerIp}</span>}
                      <Badge variant={hit.status === "success" ? "success" : hit.status === "failed" ? "destructive" : "secondary"} className="capitalize text-[10px] ml-auto">{hit.status}</Badge>
                    </div>
                    <pre className="text-[11px] font-mono text-muted-foreground whitespace-pre-wrap break-all line-clamp-3">{hit.snippet}</pre>
                  </Link>
                ))}
                {(outputHits?.items?.length ?? 0) === 0 && (
                  <p className="px-4 py-6 text-center text-sm text-muted-foreground">No device outputs match “{submittedQ}”.</p>
                )}
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      <SelectionBar count={selection.count} label="jobs" onDelete={handleBulkDelete} onClear={selection.clear} isDeleting={isBulkDeleting} />

      <Card className="glass-panel">
        <CardContent className="p-0">
          {isLoading ? (
            <div className="divide-y divide-border/50">
              {Array.from({ length: 4 }).map((_, i) => (
                <div key={i} className="flex items-start gap-3 p-6">
                  <Skeleton className="h-4 w-4 mt-1 rounded" />
                  <div className="flex-1 space-y-2">
                    <Skeleton className="h-5 w-48" />
                    <Skeleton className="h-3 w-64" />
                    <Skeleton className="h-3 w-36" />
                  </div>
                  <div className="space-y-2 text-right">
                    <Skeleton className="h-6 w-24 rounded-full" />
                    <Skeleton className="h-4 w-32" />
                  </div>
                </div>
              ))}
            </div>
          ) : sortedJobs.length === 0 ? (
            <div className="p-12 text-center">
              <PlaySquare className="w-12 h-12 mx-auto text-muted-foreground/30 mb-4" />
              <h3 className="text-lg font-medium">No jobs found</h3>
              <p className="text-muted-foreground mt-1">
                {search || filterStatus ? "Try adjusting your filters." : "Create a new batch job to execute scripts."}
              </p>
            </div>
          ) : (
            <div className="divide-y divide-border/50">
              <div className="px-4 py-3 bg-black/20 flex items-center gap-3 border-b border-border/50">
                <Checkbox
                  checked={selection.isAllSelected}
                  onCheckedChange={selection.toggleAll}
                  aria-label="Select all jobs"
                  {...(selection.isSomeSelected ? { "data-state": "indeterminate" as any } : {})}
                />
                <span className="text-xs text-muted-foreground">Select all</span>
              </div>
              {sortedJobs.map(job => {
                const displayStatus = getDisplayStatus(job);
                return (
                <div key={job.id} className="flex items-start gap-3 hover:bg-white/5 transition-colors">
                  <div className="pl-4 pt-6 shrink-0" onClick={(e) => e.stopPropagation()}>
                    <Checkbox
                      checked={selection.selected.has(job.id)}
                      onCheckedChange={() => selection.toggle(job.id)}
                    />
                  </div>
                  <Link href={`/jobs/${job.id}`} className="block flex-1 min-w-0">
                    <div className="p-6 pl-0 flex flex-col md:flex-row md:items-center justify-between gap-4">
                    <div className="space-y-1.5 min-w-0 flex-1">
                      <h4 className="font-semibold text-lg text-primary">{job.name}</h4>
                      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                        <span>Start: {formatDate(job.createdAt)}</span>
                        {job.completedAt ? (
                          <span>End: {formatDate(job.completedAt)}</span>
                        ) : job.status === "running" ? (
                          <span className="text-primary/70">Running...</span>
                        ) : null}
                        <span className="flex items-center gap-1">
                          <Timer className="w-3 h-3" />
                          {job.status === "scheduled"
                            ? "Pending"
                            : formatDuration(job.createdAt, job.completedAt)}
                          {job.status === "running" && <span className="text-primary/70">(elapsed)</span>}
                        </span>
                      </div>
                    </div>
                    
                    <div className="flex flex-col items-start md:items-end gap-2 shrink-0">
                      <Badge variant={displayStatus.variant as any} className="text-sm py-1 px-3">
                        {displayStatus.icon}
                        {displayStatus.label}
                      </Badge>
                      <div className="flex flex-col items-start md:items-end">
                        <div className="flex gap-2 text-sm mb-1">
                          <span className="text-emerald-400">{job.completedTasks} OK</span>
                          <span className="text-destructive">{job.failedTasks} ERR</span>
                          <span className="text-muted-foreground">/ {job.totalTasks} TOTAL</span>
                        </div>
                        {job.status === 'running' && (
                          <div className="w-32 h-1.5 bg-black/40 rounded-full overflow-hidden">
                            <div 
                              className="h-full bg-primary" 
                              style={{ width: `${(job.completedTasks + job.failedTasks) / job.totalTasks * 100}%` }}
                            />
                          </div>
                        )}
                      </div>

                      <div className="flex gap-1.5">
                        {(job.status === "running" || job.status === "scheduled") && (
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-8 px-2.5 text-xs gap-1.5 text-destructive hover:text-destructive hover:bg-destructive/10"
                            onClick={(e) => handleCancel(e, job.id, job.status)}
                            title={job.status === "running" ? "Stop" : "Cancel"}
                          >
                            <Square className="w-3.5 h-3.5 fill-current" />
                            {job.status === "running" ? "Stop" : "Cancel"}
                          </Button>
                        )}
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-8 px-2.5 text-xs gap-1.5 text-primary hover:text-primary hover:bg-primary/10"
                          onClick={(e) => handleRerun(e, job.id)}
                          title="Run Now"
                        >
                          <Play className="w-3.5 h-3.5 fill-current" /> Run
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-8 px-2.5 text-xs gap-1.5 text-muted-foreground hover:text-foreground"
                          onClick={(e) => handleCopyToNew(e, job.id)}
                          title="Copy to New"
                        >
                          <Copy className="w-3.5 h-3.5" /> Copy
                        </Button>
                        {job.status === "scheduled" && (
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-8 px-2.5 text-xs gap-1.5 text-muted-foreground hover:text-foreground"
                            onClick={(e) => handleEdit(e, job.id)}
                            title="Edit"
                          >
                            <Pencil className="w-3.5 h-3.5" /> Edit
                          </Button>
                        )}
                      </div>
                    </div>
                  </div>
                  </Link>
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
