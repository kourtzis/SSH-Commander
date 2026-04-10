import { useListRouters, useListGroups, useListSnippets, useListJobs } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Server, Network, Code2, Activity, PlayCircle, XCircle, CheckCircle2, Clock, Ban } from "lucide-react";
import { motion } from "framer-motion";
import { Link } from "wouter";
import { formatDate } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";

export default function Dashboard() {
  const { data: routers = [] } = useListRouters();
  const { data: groups = [] } = useListGroups();
  const { data: snippets = [] } = useListSnippets();
  const { data: jobs = [] } = useListJobs();

  const recentJobs = [...jobs].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()).slice(0, 5);

  const stats = [
    { label: "Total Devices", value: routers.length, icon: Server, color: "text-blue-400", bg: "bg-blue-400/10", border: "border-blue-400/20", href: "/routers" },
    { label: "Device Groups", value: groups.length, icon: Network, color: "text-purple-400", bg: "bg-purple-400/10", border: "border-purple-400/20", href: "/groups" },
    { label: "Code Snippets", value: snippets.length, icon: Code2, color: "text-amber-400", bg: "bg-amber-400/10", border: "border-amber-400/20", href: "/snippets" },
    { label: "Active Jobs", value: jobs.filter(j => j.status === 'running' || j.status === 'pending').length, icon: Activity, color: "text-emerald-400", bg: "bg-emerald-400/10", border: "border-emerald-400/20", href: "/jobs" },
  ];

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Dashboard</h1>
        <p className="text-muted-foreground mt-2">Overview of your SSH infrastructure.</p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-6">
        {stats.map((stat, i) => (
          <motion.div
            key={stat.label}
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: i * 0.1 }}
          >
            <Link href={stat.href} className="block">
              <Card className="glass-panel hover:shadow-2xl hover:shadow-primary/5 hover:border-primary/20 transition-all duration-300 cursor-pointer">
                <CardContent className="p-6 flex items-center justify-between">
                  <div>
                    <p className="text-sm font-medium text-muted-foreground mb-1">{stat.label}</p>
                    <p className="text-3xl font-display font-bold">{stat.value}</p>
                  </div>
                  <div className={`p-4 rounded-2xl ${stat.bg} ${stat.border} border`}>
                    <stat.icon className={`w-8 h-8 ${stat.color}`} />
                  </div>
                </CardContent>
              </Card>
            </Link>
          </motion.div>
        ))}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
        <Card className="glass-panel col-span-1 lg:col-span-2">
          <CardHeader className="flex flex-row items-center justify-between">
            <CardTitle className="flex items-center gap-2">
              <Clock className="w-5 h-5 text-primary" />
              Recent Jobs
            </CardTitle>
            <Link href="/jobs" className="text-sm text-primary hover:underline">View all</Link>
          </CardHeader>
          <CardContent>
            {recentJobs.length === 0 ? (
              <div className="text-center py-8 text-muted-foreground">No recent jobs found.</div>
            ) : (
              <div className="space-y-4">
                {recentJobs.map((job) => (
                  <Link key={job.id} href={`/jobs/${job.id}`} className="block">
                    <div className="flex items-center justify-between p-4 rounded-xl border border-white/5 bg-black/20 hover:bg-white/5 transition-colors cursor-pointer group">
                      <div>
                        <h4 className="font-semibold text-foreground group-hover:text-primary transition-colors">{job.name}</h4>
                        <p className="text-sm text-muted-foreground mt-1">Started: {formatDate(job.createdAt)}</p>
                      </div>
                      <div className="flex items-center gap-6">
                        <div className="text-right hidden sm:block">
                          <p className="text-sm font-medium">{job.completedTasks} / {job.totalTasks} Tasks</p>
                          <p className="text-xs text-muted-foreground">{job.failedTasks} failed</p>
                        </div>
                        <Badge variant={
                          job.status === 'running' ? 'default' :
                          job.status === 'scheduled' ? 'outline' :
                          job.status === 'cancelled' ? 'secondary' :
                          job.status === 'completed' && job.failedTasks > 0 && job.completedTasks > 0 ? 'warning' :
                          job.status === 'completed' && job.failedTasks > 0 ? 'destructive' :
                          job.status === 'completed' ? 'success' :
                          job.status === 'failed' ? 'destructive' : 'secondary'
                        }>
                          {job.status === 'running' && <PlayCircle className="w-3 h-3 mr-1 animate-pulse" />}
                          {job.status === 'completed' && <CheckCircle2 className="w-3 h-3 mr-1" />}
                          {job.status === 'failed' && <XCircle className="w-3 h-3 mr-1" />}
                          {job.status === 'cancelled' && <Ban className="w-3 h-3 mr-1" />}
                          {job.status === 'scheduled' && <Clock className="w-3 h-3 mr-1" />}
                          {job.status === 'running' ? 'Running' :
                           job.status === 'scheduled' ? 'Scheduled' :
                           job.status === 'cancelled' ? 'Stopped' :
                           job.status === 'completed' && job.failedTasks > 0 && job.completedTasks > 0 ? 'Partially Successful' :
                           job.status === 'completed' && job.failedTasks > 0 ? 'Failed' :
                           job.status === 'completed' ? 'Successful' :
                           job.status === 'failed' ? 'Failed' : job.status}
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
    </div>
  );
}
