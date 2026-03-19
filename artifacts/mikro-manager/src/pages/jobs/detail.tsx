import { useParams } from "wouter";
import { useGetJob } from "@workspace/api-client-react";
import { useJobsMutations } from "@/hooks/use-mutations";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Ban, CheckCircle2, XCircle, PlayCircle, Terminal, Clock } from "lucide-react";
import { formatDate } from "@/lib/utils";
import { SnippetViewer } from "@/components/snippet-viewer";
import { useToast } from "@/hooks/use-toast";

export default function JobDetail() {
  const { id } = useParams<{ id: string }>();
  const jobId = parseInt(id);
  const { toast } = useToast();
  const { cancelJob } = useJobsMutations();

  // Poll if status is running or pending
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
        </div>
        <CardContent className="p-0">
          {job.tasks.length === 0 ? (
            <div className="p-8 text-center text-muted-foreground">No tasks generated for this job.</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm text-left">
                <thead className="bg-black/40 text-muted-foreground text-xs uppercase border-b border-border/50">
                  <tr>
                    <th className="px-6 py-4 font-medium">Status</th>
                    <th className="px-6 py-4 font-medium">Router</th>
                    <th className="px-6 py-4 font-medium">Time</th>
                    <th className="px-6 py-4 font-medium">Output</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border/50">
                  {job.tasks.map(task => (
                    <tr key={task.id} className="hover:bg-white/5 transition-colors">
                      <td className="px-6 py-4">
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
                      </td>
                      <td className="px-6 py-4">
                        <div className="font-medium text-foreground">{task.routerName}</div>
                        <div className="text-xs text-muted-foreground font-mono">{task.routerIp}</div>
                      </td>
                      <td className="px-6 py-4 text-xs text-muted-foreground whitespace-nowrap">
                        {task.startedAt ? formatDate(task.startedAt).split(' ')[1] : '-'} <br/>
                        {task.completedAt ? formatDate(task.completedAt).split(' ')[1] : ''}
                      </td>
                      <td className="px-6 py-4">
                        {task.errorMessage ? (
                          <div className="text-destructive text-xs font-mono bg-destructive/10 p-2 rounded border border-destructive/20 max-w-lg overflow-x-auto whitespace-pre-wrap">
                            {task.errorMessage}
                          </div>
                        ) : task.output ? (
                          <div className="text-emerald-400 text-xs font-mono bg-black/40 p-2 rounded border border-white/5 max-w-lg overflow-x-auto whitespace-pre-wrap">
                            {task.output}
                          </div>
                        ) : (
                          <span className="text-muted-foreground italic text-xs">No output</span>
                        )}
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
