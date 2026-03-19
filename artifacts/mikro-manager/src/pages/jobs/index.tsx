import { useListJobs } from "@workspace/api-client-react";
import { Link } from "wouter";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Plus, PlaySquare, CheckCircle2, XCircle, PlayCircle, Ban } from "lucide-react";
import { formatDate } from "@/lib/utils";

export default function JobsList() {
  const { data: jobs = [], isLoading } = useListJobs();

  // Sort jobs descending by date
  const sortedJobs = [...jobs].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

  const getStatusIcon = (status: string) => {
    switch(status) {
      case 'completed': return <CheckCircle2 className="w-4 h-4 mr-1.5" />;
      case 'failed': return <XCircle className="w-4 h-4 mr-1.5" />;
      case 'running': return <PlayCircle className="w-4 h-4 mr-1.5 animate-pulse" />;
      case 'cancelled': return <Ban className="w-4 h-4 mr-1.5" />;
      default: return null;
    }
  };

  const getStatusVariant = (status: string) => {
    switch(status) {
      case 'completed': return 'success';
      case 'failed': return 'destructive';
      case 'running': return 'default';
      case 'cancelled': return 'secondary';
      default: return 'outline';
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
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
              {sortedJobs.map(job => (
                <Link key={job.id} href={`/jobs/${job.id}`} className="block hover:bg-white/5 transition-colors">
                  <div className="p-6 flex flex-col md:flex-row md:items-center justify-between gap-4">
                    <div className="space-y-1">
                      <h4 className="font-semibold text-lg text-primary">{job.name}</h4>
                      <p className="text-sm text-muted-foreground font-mono truncate max-w-md">
                        {job.scriptCode.split('\n')[0]}...
                      </p>
                      <div className="flex gap-4 text-xs text-muted-foreground pt-1">
                        <span>Started: {formatDate(job.createdAt)}</span>
                        {job.completedAt && <span>Finished: {formatDate(job.completedAt)}</span>}
                      </div>
                    </div>
                    
                    <div className="flex items-center gap-6">
                      <div className="flex flex-col items-end">
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
                      <Badge variant={getStatusVariant(job.status) as any} className="capitalize text-sm py-1 px-3">
                        {getStatusIcon(job.status)}
                        {job.status}
                      </Badge>
                    </div>
                  </div>
                </Link>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
