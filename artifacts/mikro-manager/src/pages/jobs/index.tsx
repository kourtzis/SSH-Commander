import { useState } from "react";
import { useListJobs } from "@workspace/api-client-react";
import { Link, useLocation } from "wouter";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Plus, PlaySquare, CheckCircle2, XCircle, PlayCircle, Ban, Play, Copy, Pencil, Clock, Square, Timer } from "lucide-react";
import { formatDate } from "@/lib/utils";
import { useJobsMutations } from "@/hooks/use-mutations";
import { useToast } from "@/hooks/use-toast";
import { useSelection } from "@/hooks/use-selection";
import { SelectionBar } from "@/components/selection-bar";

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
  const [, setLocation] = useLocation();
  const { rerunJob, cancelJob, deleteJob } = useJobsMutations();
  const { toast } = useToast();
  const [isBulkDeleting, setIsBulkDeleting] = useState(false);

  const sortedJobs = [...jobs].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
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

  const handleStop = async (e: React.MouseEvent, jobId: number, status: string) => {
    e.preventDefault();
    e.stopPropagation();
    const action = status === "scheduled" ? "unschedule" : "stop";
    if (!confirm(`Are you sure you want to ${action} this job?`)) return;
    try {
      await cancelJob.mutateAsync({ id: jobId });
      toast({ title: status === "scheduled" ? "Job unscheduled" : "Job stopped" });
    } catch (err: any) {
      toast({ title: `Failed to ${action} job`, description: err.message, variant: "destructive" });
    }
  };

  const handleBulkDelete = async () => {
    if (!confirm(`Delete ${selection.count} selected job(s)?`)) return;
    setIsBulkDeleting(true);
    try {
      await Promise.all(selection.ids.map(id => deleteJob.mutateAsync({ id })));
      toast({ title: `${selection.count} job(s) deleted` });
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

      <SelectionBar count={selection.count} label="jobs" onDelete={handleBulkDelete} onClear={selection.clear} isDeleting={isBulkDeleting} />

      <Card className="glass-panel">
        <CardContent className="p-0">
          {isLoading ? (
            <div className="p-8 text-center text-muted-foreground">Loading jobs...</div>
          ) : sortedJobs.length === 0 ? (
            <div className="p-12 text-center">
              <PlaySquare className="w-12 h-12 mx-auto text-muted-foreground/30 mb-4" />
              <h3 className="text-lg font-medium">No jobs found</h3>
              <p className="text-muted-foreground mt-1">Create a new batch job to execute scripts.</p>
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
              {sortedJobs.map(job => (
                <div key={job.id} className="flex items-start gap-3 hover:bg-white/5 transition-colors">
                  <div className="pl-4 pt-6 shrink-0" onClick={(e) => e.stopPropagation()}>
                    <Checkbox
                      checked={selection.selected.has(job.id)}
                      onCheckedChange={() => selection.toggle(job.id)}
                    />
                  </div>
                  <Link href={`/jobs/${job.id}`} className="block flex-1 min-w-0">
                    <div className="p-6 pl-0 flex flex-col md:flex-row md:items-center justify-between gap-4">
                    <div className="space-y-1 min-w-0 flex-1">
                      <h4 className="font-semibold text-lg text-primary">{job.name}</h4>
                      <p className="text-sm text-muted-foreground font-mono truncate max-w-md">
                        {job.scriptCode.split('\n')[0]}...
                      </p>
                      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground pt-1">
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
                      <Badge variant={getDisplayStatus(job).variant as any} className="text-sm py-1 px-3">
                        {getDisplayStatus(job).icon}
                        {getDisplayStatus(job).label}
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
                            onClick={(e) => handleStop(e, job.id, job.status)}
                            title={job.status === "scheduled" ? "Unschedule" : "Stop"}
                          >
                            <Square className="w-3.5 h-3.5 fill-current" />
                            {job.status === "scheduled" ? "Unschedule" : "Stop"}
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
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-8 px-2.5 text-xs gap-1.5 text-muted-foreground hover:text-foreground"
                          onClick={(e) => handleEdit(e, job.id)}
                          title="Edit"
                        >
                          <Pencil className="w-3.5 h-3.5" /> Edit
                        </Button>
                      </div>
                    </div>
                  </div>
                  </Link>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
