import { useState, useEffect } from "react";
import { useLocation, useSearch } from "wouter";
import { useListJobs } from "@workspace/api-client-react";
import { useSchedulesMutations } from "@/hooks/use-mutations";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Clock, Calendar, Repeat, Save } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

const DAYS = [
  { value: 0, label: "Sun" },
  { value: 1, label: "Mon" },
  { value: 2, label: "Tue" },
  { value: 3, label: "Wed" },
  { value: 4, label: "Thu" },
  { value: 5, label: "Fri" },
  { value: 6, label: "Sat" },
];

type ScheduleType = "once" | "interval" | "weekly";

export default function NewSchedule() {
  const [, setLocation] = useLocation();
  const search = useSearch();
  const params = new URLSearchParams(search);
  const presetJobId = params.get("jobId");

  const { data: jobs = [] } = useListJobs();
  const { createSchedule } = useSchedulesMutations();
  const { toast } = useToast();

  const [name, setName] = useState("");
  const [jobId, setJobId] = useState<number | "">(presetJobId ? parseInt(presetJobId) : "");
  const [type, setType] = useState<ScheduleType>("once");
  const [scheduledAt, setScheduledAt] = useState("");
  const [intervalMinutes, setIntervalMinutes] = useState(60);
  const [selectedDays, setSelectedDays] = useState<number[]>([1, 2, 3, 4, 5]);
  const [timeOfDay, setTimeOfDay] = useState("08:00");
  const [isSubmitting, setIsSubmitting] = useState(false);

  const scheduledJobs = jobs.filter(j => j.status === "scheduled");
  const availableJobs = scheduledJobs;

  useEffect(() => {
    if (presetJobId && jobs.length > 0) {
      const job = jobs.find(j => j.id === parseInt(presetJobId));
      if (job && !name) {
        setName(`Schedule: ${job.name}`);
      }
    }
  }, [presetJobId, jobs, name]);

  const handleSubmit = async () => {
    if (!name || !jobId) {
      toast({ title: "Missing fields", description: "Please provide a name and select a job template.", variant: "destructive" });
      return;
    }

    setIsSubmitting(true);
    try {
      const payload: any = {
        name,
        jobId: Number(jobId),
        type,
      };

      if (type === "once" && scheduledAt) {
        payload.scheduledAt = new Date(scheduledAt).toISOString();
      }
      if (type === "interval") {
        payload.intervalMinutes = intervalMinutes;
      }
      if (type === "weekly") {
        payload.daysOfWeek = selectedDays;
        payload.timeOfDay = timeOfDay;
      }

      await createSchedule.mutateAsync({ data: payload });
      toast({ title: "Schedule created!" });
      setLocation("/scheduler");
    } catch (e: any) {
      toast({ title: "Failed to create schedule", description: e.message, variant: "destructive" });
      setIsSubmitting(false);
    }
  };

  const toggleDay = (day: number) => {
    setSelectedDays(prev =>
      prev.includes(day) ? prev.filter(d => d !== day) : [...prev, day].sort()
    );
  };

  const typeOptions: { value: ScheduleType; label: string; icon: React.ReactNode; desc: string }[] = [
    { value: "once", label: "One-Time", icon: <Clock className="w-5 h-5" />, desc: "Run once at a specific date & time" },
    { value: "interval", label: "Interval", icon: <Repeat className="w-5 h-5" />, desc: "Repeat at a fixed interval" },
    { value: "weekly", label: "Weekly", icon: <Calendar className="w-5 h-5" />, desc: "Run on selected days each week" },
  ];

  return (
    <div className="max-w-2xl mx-auto space-y-6 pb-20">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">New Schedule</h1>
        <p className="text-muted-foreground mt-1">Set up a scheduled or recurring job execution.</p>
      </div>

      <Card className="glass-panel">
        <CardHeader>
          <CardTitle className="text-xl">Schedule Details</CardTitle>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="space-y-2">
            <Label>Schedule Name *</Label>
            <Input
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder="e.g. Nightly backup config push"
            />
          </div>

          <div className="space-y-2">
            <Label>Job Template *</Label>
            {availableJobs.length === 0 ? (
              <div className="text-sm text-muted-foreground p-4 border border-dashed rounded-xl text-center">
                No scheduled job templates found. Create a batch job with "Schedule" mode first.
              </div>
            ) : (
              <select
                className="w-full h-10 rounded-lg border bg-background px-3 text-sm"
                value={jobId}
                onChange={e => setJobId(e.target.value ? parseInt(e.target.value) : "")}
              >
                <option value="">Select a job template...</option>
                {availableJobs.map(j => (
                  <option key={j.id} value={j.id}>{j.name}</option>
                ))}
              </select>
            )}
          </div>
        </CardContent>
      </Card>

      <Card className="glass-panel">
        <CardHeader>
          <CardTitle className="text-xl">Schedule Type</CardTitle>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="grid grid-cols-3 gap-3">
            {typeOptions.map(opt => (
              <button
                key={opt.value}
                onClick={() => setType(opt.value)}
                className={`p-4 rounded-xl border text-left transition-all ${
                  type === opt.value
                    ? "border-primary bg-primary/10 shadow-[0_0_15px_rgba(45,212,191,0.15)]"
                    : "border-white/10 hover:border-white/20 bg-black/20"
                }`}
              >
                <div className={`mb-2 ${type === opt.value ? "text-primary" : "text-muted-foreground"}`}>
                  {opt.icon}
                </div>
                <div className="font-medium text-sm">{opt.label}</div>
                <div className="text-xs text-muted-foreground mt-0.5">{opt.desc}</div>
              </button>
            ))}
          </div>

          {type === "once" && (
            <div className="space-y-2">
              <Label>Run At</Label>
              <Input
                type="datetime-local"
                value={scheduledAt}
                onChange={e => setScheduledAt(e.target.value)}
              />
            </div>
          )}

          {type === "interval" && (
            <div className="space-y-2">
              <Label>Interval (minutes)</Label>
              <Input
                type="number"
                min={1}
                value={intervalMinutes}
                onChange={e => setIntervalMinutes(parseInt(e.target.value) || 1)}
              />
              <p className="text-xs text-muted-foreground">
                {intervalMinutes >= 60
                  ? `= ${Math.floor(intervalMinutes / 60)}h ${intervalMinutes % 60 ? `${intervalMinutes % 60}m` : ""}`
                  : `Every ${intervalMinutes} minute${intervalMinutes > 1 ? "s" : ""}`}
              </p>
            </div>
          )}

          {type === "weekly" && (
            <div className="space-y-4">
              <div className="space-y-2">
                <Label>Days of Week</Label>
                <div className="flex gap-2">
                  {DAYS.map(d => (
                    <button
                      key={d.value}
                      onClick={() => toggleDay(d.value)}
                      className={`w-10 h-10 rounded-lg text-xs font-medium transition-all ${
                        selectedDays.includes(d.value)
                          ? "bg-primary text-primary-foreground"
                          : "bg-black/30 text-muted-foreground hover:bg-white/10"
                      }`}
                    >
                      {d.label}
                    </button>
                  ))}
                </div>
              </div>
              <div className="space-y-2">
                <Label>Time of Day</Label>
                <Input
                  type="time"
                  value={timeOfDay}
                  onChange={e => setTimeOfDay(e.target.value)}
                />
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      <div className="flex justify-end pt-4">
        <Button size="lg" onClick={handleSubmit} disabled={isSubmitting} className="w-full sm:w-auto text-lg gap-2 shadow-[0_0_20px_rgba(45,212,191,0.3)]">
          {isSubmitting ? "Creating..." : <><Save className="w-5 h-5" /> Create Schedule</>}
        </Button>
      </div>
    </div>
  );
}
