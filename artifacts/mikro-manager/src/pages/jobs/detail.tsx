import { useState } from "react";
import { useParams } from "wouter";
import { useGetJob } from "@workspace/api-client-react";
import { useJobsMutations } from "@/hooks/use-mutations";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Ban, CheckCircle2, XCircle, PlayCircle, Terminal, Clock, ChevronDown, ChevronRight, ScrollText, Code } from "lucide-react";
import { formatDate } from "@/lib/utils";
import { SnippetViewer } from "@/components/snippet-viewer";
import { useToast } from "@/hooks/use-toast";

export default function JobDetail() {
  const { id } = useParams<{ id: string }>();
  const jobId = parseInt(id);
  const { toast } = useToast();
  const { cancelJob } = useJobsMutations();
  const [expandedTask, setExpandedTask] = useState<number | null>(null);

  const { data: job, isLoading } = useGetJob(jobId, {
    query: {
      refetchInterval: (query) => {
        const status = query.state.data?.status;
        return (status === 'running' || status === 'pending') ? 2000 : false;
      }
    }
  });

  if (isLoading) return <div className="p-8 text-center text-muted-foreground">Loading job details...</div>;
  if (!job) return <div className="p-8 text-center text-destructive">Job not found.</div>;

  const doneTasks = job.completedTasks + job.failedTasks;
  const remainingTasks = job.totalTasks - doneTasks;
  const progress = job.totalTasks > 0 ? (doneTasks / job.totalTasks) * 100 : 0;

  const handleCancel = async () => {
    if (confirm("Are you sure you want to cancel this running job?")) {
      try {
        await cancelJob.mutateAsync({ id: jobId });
        toast({ title: "Cancel requested" });
      } catch (e: any) {
        toast({ title: "Failed to cancel", description: e.message, variant: "destructive" });
      }
    }
  };

  const toggleTask = (taskId: number) => {
    setExpandedTask(expandedTask === taskId ? null : taskId);
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-3">
            <h1 className="text-3xl font-bold tracking-tight">{job.name}</h1>
            <Badge variant={
              job.status === 'completed' ? 'success' : 
              job.status === 'failed' ? 'destructive' : 
              job.status === 'running' ? 'default' : 'secondary'
            } className="capitalize text-sm px-3 py-1">
              {job.status === 'running' && <PlayCircle className="w-4 h-4 mr-1 animate-pulse" />}
              {job.status}
            </Badge>
          </div>
          <p className="text-muted-foreground mt-2 flex items-center gap-2">
            <Clock className="w-4 h-4" /> Started {formatDate(job.createdAt)}
            {job.completedAt && ` • Finished ${formatDate(job.completedAt)}`}
          </p>
        </div>
        
        {job.status === 'running' && (
          <Button variant="destructive" onClick={handleCancel} className="gap-2 shadow-[0_0_15px_rgba(220,38,38,0.3)]">
            <Ban className="w-4 h-4" /> Cancel Job
          </Button>
        )}
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

      <Card className="glass-panel overflow-hidden">
        <div className="p-6 border-b border-border/50 bg-black/20">
          <CardTitle className="text-xl">Task Results</CardTitle>
          <p className="text-xs text-muted-foreground mt-1">Click a row to view its SSH connection log and resolved script</p>
        </div>
        <CardContent className="p-0">
          {job.tasks.length === 0 ? (
            <div className="p-8 text-center text-muted-foreground">No tasks generated for this job.</div>
          ) : (
            <div>
              {job.tasks.map(task => {
                const isExpanded = expandedTask === task.id;
                return (
                  <div key={task.id} className="border-b border-border/50 last:border-b-0">
                    <div
                      className="flex items-center gap-4 px-6 py-4 cursor-pointer hover:bg-white/5 transition-colors select-none"
                      onClick={() => toggleTask(task.id)}
                    >
                      <div className="text-muted-foreground shrink-0">
                        {isExpanded ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
                      </div>
                      <div className="shrink-0">
                        <Badge variant={
                          task.status === 'success' ? 'success' : 
                          task.status === 'failed' ? 'destructive' : 
                          task.status === 'running' ? 'default' : 'secondary'
                        } className="capitalize">
                          {task.status === 'running' && <PlayCircle className="w-3 h-3 mr-1 animate-pulse" />}
                          {task.status === 'success' && <CheckCircle2 className="w-3 h-3 mr-1" />}
                          {task.status === 'failed' && <XCircle className="w-3 h-3 mr-1" />}
                          {task.status}
                        </Badge>
                      </div>
                      <div className="flex-1 min-w-0">
                        <span className="font-medium text-sm text-foreground">{task.routerName}</span>
                        <span className="text-xs text-muted-foreground font-mono ml-2">{task.routerIp}</span>
                      </div>
                      <div className="text-xs text-muted-foreground whitespace-nowrap shrink-0">
                        {task.startedAt && task.completedAt ? (
                          <span>{Math.round((new Date(task.completedAt).getTime() - new Date(task.startedAt).getTime()) / 1000)}s</span>
                        ) : task.status === 'running' ? (
                          <span className="animate-pulse">running...</span>
                        ) : task.status === 'pending' ? (
                          <span>waiting</span>
                        ) : '-'}
                      </div>
                      <div className="shrink-0 max-w-xs truncate">
                        {task.errorMessage ? (
                          <span className="text-xs text-destructive truncate">{task.errorMessage}</span>
                        ) : task.output ? (
                          <span className="text-xs text-emerald-400 truncate">{task.output.slice(0, 60)}{task.output.length > 60 ? "..." : ""}</span>
                        ) : null}
                      </div>
                    </div>

                    {isExpanded && (
                      <div className="px-6 pb-6 pt-2 bg-black/20 space-y-4 border-t border-white/5">
                        {task.output && (
                          <div>
                            <div className="flex items-center gap-2 mb-2">
                              <Terminal className="w-3.5 h-3.5 text-emerald-400" />
                              <span className="text-xs font-semibold uppercase text-emerald-400">Output</span>
                            </div>
                            <pre className="text-xs font-mono text-emerald-400 bg-black/40 p-4 rounded-xl border border-white/5 overflow-x-auto whitespace-pre-wrap max-h-48 overflow-y-auto">{task.output}</pre>
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

                        {(task as any).connectionLog && (
                          <div>
                            <div className="flex items-center gap-2 mb-2">
                              <ScrollText className="w-3.5 h-3.5 text-yellow-400" />
                              <span className="text-xs font-semibold uppercase text-yellow-400">SSH Connection Log</span>
                            </div>
                            <pre className="text-xs font-mono text-muted-foreground bg-black/60 p-4 rounded-xl border border-yellow-500/20 overflow-x-auto whitespace-pre-wrap max-h-64 overflow-y-auto leading-relaxed">{(task as any).connectionLog}</pre>
                          </div>
                        )}

                        {!task.output && !task.errorMessage && !(task as any).connectionLog && !(task as any).resolvedScript && (
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
