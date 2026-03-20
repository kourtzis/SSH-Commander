import { useListSchedules, useListJobs } from "@workspace/api-client-react";
import { useSchedulesMutations } from "@/hooks/use-mutations";
import { Link } from "wouter";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Plus, Clock, Calendar, Repeat, Trash2 } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function formatScheduleType(type: string, schedule: any) {
  if (type === "once") {
    return schedule.scheduledAt
      ? `Once at ${new Date(schedule.scheduledAt).toLocaleString()}`
      : "Once (no time set)";
  }
  if (type === "interval") {
    const mins = schedule.intervalMinutes ?? 0;
    if (mins >= 60) return `Every ${Math.floor(mins / 60)}h ${mins % 60 ? `${mins % 60}m` : ""}`;
    return `Every ${mins}m`;
  }
  if (type === "weekly") {
    const days = (schedule.daysOfWeek ?? []).map((d: number) => DAY_NAMES[d]).join(", ");
    return `${days} at ${schedule.timeOfDay ?? "00:00"}`;
  }
  return type;
}

function typeIcon(type: string) {
  if (type === "once") return <Clock className="w-4 h-4" />;
  if (type === "interval") return <Repeat className="w-4 h-4" />;
  return <Calendar className="w-4 h-4" />;
}

export default function SchedulerList() {
  const { data: schedules = [], isLoading } = useListSchedules();
  const { data: jobs = [] } = useListJobs();
  const { updateSchedule, deleteSchedule } = useSchedulesMutations();
  const { toast } = useToast();

  const jobMap = new Map(jobs.map((j) => [j.id, j]));

  const handleToggle = async (id: number, enabled: boolean) => {
    try {
      await updateSchedule.mutateAsync({ id, data: { enabled } });
    } catch {
      toast({ title: "Failed to update schedule", variant: "destructive" });
    }
  };

  const handleDelete = async (id: number) => {
    if (!confirm("Delete this schedule?")) return;
    try {
      await deleteSchedule.mutateAsync({ id });
      toast({ title: "Schedule deleted" });
    } catch {
      toast({ title: "Failed to delete schedule", variant: "destructive" });
    }
  };

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Scheduler</h1>
          <p className="text-muted-foreground mt-1">Manage scheduled and recurring jobs.</p>
        </div>
        <Link href="/scheduler/new">
          <Button className="gap-2">
            <Plus className="w-4 h-4" /> New Schedule
          </Button>
        </Link>
      </div>

      {isLoading ? (
        <div className="text-center text-muted-foreground py-12">Loading...</div>
      ) : schedules.length === 0 ? (
        <Card className="glass-panel">
          <CardContent className="py-16 text-center text-muted-foreground">
            <Clock className="w-12 h-12 mx-auto mb-4 opacity-40" />
            <p className="text-lg font-medium">No schedules yet</p>
            <p className="text-sm mt-1">Create a batch job and schedule it, or create a schedule directly.</p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {schedules.map((s) => {
            const job = jobMap.get(s.jobId);
            return (
              <Card key={s.id} className="glass-panel">
                <CardContent className="py-4">
                  <div className="flex items-center justify-between gap-4">
                    <div className="flex items-center gap-3 min-w-0 flex-1">
                      <div className="text-primary">{typeIcon(s.type)}</div>
                      <div className="min-w-0">
                        <div className="font-medium truncate">{s.name}</div>
                        <div className="text-xs text-muted-foreground flex items-center gap-2 mt-0.5">
                          <span>{formatScheduleType(s.type, s)}</span>
                          <span className="text-white/20">|</span>
                          <span>Job: {job?.name ?? `#${s.jobId}`}</span>
                          {s.runCount > 0 && (
                            <>
                              <span className="text-white/20">|</span>
                              <span>Runs: {s.runCount}</span>
                            </>
                          )}
                        </div>
                        {s.nextRunAt && (
                          <div className="text-xs text-primary/70 mt-0.5">
                            Next: {new Date(s.nextRunAt).toLocaleString()}
                          </div>
                        )}
                      </div>
                    </div>

                    <div className="flex items-center gap-3 shrink-0">
                      <Badge variant={s.enabled ? "default" : "secondary"}>
                        {s.enabled ? "Active" : "Paused"}
                      </Badge>
                      <Switch
                        checked={s.enabled}
                        onCheckedChange={(val) => handleToggle(s.id, val)}
                      />
                      <Button
                        size="icon"
                        variant="ghost"
                        className="text-destructive/60 hover:text-destructive"
                        onClick={() => handleDelete(s.id)}
                      >
                        <Trash2 className="w-4 h-4" />
                      </Button>
                    </div>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
