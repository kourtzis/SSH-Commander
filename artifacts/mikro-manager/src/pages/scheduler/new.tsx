import { useState, useEffect } from "react";
import { useLocation, useSearch } from "wouter";
import { useListJobs } from "@workspace/api-client-react";
import { useSchedulesMutations } from "@/hooks/use-mutations";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Clock, CalendarClock, Save } from "lucide-react";
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

const NTH_LABELS = ["1st", "2nd", "3rd", "4th", "5th"];
const WEEKDAY_LABELS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

type ScheduleCategory = "once" | "recurring";
type RecurringMode = "interval" | "daily" | "weekly" | "monthly";
type MonthlyMode = "dayOfMonth" | "nthWeekday";

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
  const [category, setCategory] = useState<ScheduleCategory>("once");
  const [recurringMode, setRecurringMode] = useState<RecurringMode>("daily");
  const [scheduledAt, setScheduledAt] = useState("");
  const [intervalMinutes, setIntervalMinutes] = useState(60);
  const [timeOfDay, setTimeOfDay] = useState("08:00");
  const [selectedDays, setSelectedDays] = useState<number[]>([1, 2, 3, 4, 5]);
  const [monthlyMode, setMonthlyMode] = useState<MonthlyMode>("dayOfMonth");
  const [dayOfMonth, setDayOfMonth] = useState(1);
  const [nthWeek, setNthWeek] = useState(1);
  const [nthWeekday, setNthWeekday] = useState(1);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const scheduledJobs = jobs.filter(j => j.status === "scheduled");

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
      const type = category === "once" ? "once" : recurringMode;
      const payload: any = { name, jobId: Number(jobId), type };

      if (type === "once" && scheduledAt) {
        payload.scheduledAt = new Date(scheduledAt).toISOString();
      }
      if (type === "interval") {
        payload.intervalMinutes = intervalMinutes;
      }
      if (type === "daily") {
        payload.timeOfDay = timeOfDay;
      }
      if (type === "weekly") {
        payload.daysOfWeek = selectedDays;
        payload.timeOfDay = timeOfDay;
      }
      if (type === "monthly") {
        payload.timeOfDay = timeOfDay;
        payload.monthlyMode = monthlyMode;
        if (monthlyMode === "dayOfMonth") {
          payload.dayOfMonth = dayOfMonth;
        } else {
          payload.nthWeek = nthWeek;
          payload.nthWeekday = nthWeekday;
        }
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

  const categoryOptions: { value: ScheduleCategory; label: string; icon: React.ReactNode; desc: string }[] = [
    { value: "once", label: "One-Time", icon: <Clock className="w-5 h-5" />, desc: "Run once at a specific date & time" },
    { value: "recurring", label: "Recurring", icon: <CalendarClock className="w-5 h-5" />, desc: "Interval, daily, weekly, or monthly" },
  ];

  const recurringOptions: { value: RecurringMode; label: string; desc: string }[] = [
    { value: "interval", label: "Interval", desc: "Every N minutes" },
    { value: "daily", label: "Daily", desc: "Every day at a set time" },
    { value: "weekly", label: "Weekly", desc: "Selected days each week" },
    { value: "monthly", label: "Monthly", desc: "Specific day each month" },
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
            {scheduledJobs.length === 0 ? (
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
                {scheduledJobs.map(j => (
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
          <div className="grid grid-cols-2 gap-3">
            {categoryOptions.map(opt => (
              <button
                key={opt.value}
                onClick={() => setCategory(opt.value)}
                className={`p-4 rounded-xl border text-left transition-all ${
                  category === opt.value
                    ? "border-primary bg-primary/10 shadow-[0_0_15px_rgba(45,212,191,0.15)]"
                    : "border-white/10 hover:border-white/20 bg-black/20"
                }`}
              >
                <div className={`mb-2 ${category === opt.value ? "text-primary" : "text-muted-foreground"}`}>
                  {opt.icon}
                </div>
                <div className="font-medium text-sm">{opt.label}</div>
                <div className="text-xs text-muted-foreground mt-0.5">{opt.desc}</div>
              </button>
            ))}
          </div>

          {category === "once" && (
            <div className="space-y-2">
              <Label>Run At</Label>
              <Input
                type="datetime-local"
                value={scheduledAt}
                onChange={e => setScheduledAt(e.target.value)}
              />
            </div>
          )}

          {category === "recurring" && (
            <div className="space-y-5">
              <div className="grid grid-cols-4 gap-2">
                {recurringOptions.map(opt => (
                  <button
                    key={opt.value}
                    onClick={() => setRecurringMode(opt.value)}
                    className={`p-3 rounded-lg border text-center transition-all ${
                      recurringMode === opt.value
                        ? "border-primary bg-primary/10 text-primary"
                        : "border-white/10 hover:border-white/20 bg-black/20 text-muted-foreground"
                    }`}
                  >
                    <div className="font-medium text-sm">{opt.label}</div>
                    <div className="text-[10px] mt-0.5 opacity-70">{opt.desc}</div>
                  </button>
                ))}
              </div>

              {recurringMode === "interval" && (
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

              {recurringMode === "daily" && (
                <div className="space-y-2">
                  <Label>Time of Day</Label>
                  <Input
                    type="time"
                    value={timeOfDay}
                    onChange={e => setTimeOfDay(e.target.value)}
                  />
                </div>
              )}

              {recurringMode === "weekly" && (
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

              {recurringMode === "monthly" && (
                <div className="space-y-4">
                  <div className="space-y-2">
                    <Label>Monthly Mode</Label>
                    <div className="grid grid-cols-2 gap-2">
                      <button
                        onClick={() => setMonthlyMode("dayOfMonth")}
                        className={`p-3 rounded-lg border text-center transition-all ${
                          monthlyMode === "dayOfMonth"
                            ? "border-primary bg-primary/10 text-primary"
                            : "border-white/10 hover:border-white/20 bg-black/20 text-muted-foreground"
                        }`}
                      >
                        <div className="font-medium text-sm">Specific Day</div>
                        <div className="text-[10px] mt-0.5 opacity-70">e.g. on the 14th</div>
                      </button>
                      <button
                        onClick={() => setMonthlyMode("nthWeekday")}
                        className={`p-3 rounded-lg border text-center transition-all ${
                          monthlyMode === "nthWeekday"
                            ? "border-primary bg-primary/10 text-primary"
                            : "border-white/10 hover:border-white/20 bg-black/20 text-muted-foreground"
                        }`}
                      >
                        <div className="font-medium text-sm">Nth Weekday</div>
                        <div className="text-[10px] mt-0.5 opacity-70">e.g. 2nd Tuesday</div>
                      </button>
                    </div>
                  </div>

                  {monthlyMode === "dayOfMonth" && (
                    <div className="space-y-2">
                      <Label>Day of Month</Label>
                      <Input
                        type="number"
                        min={1}
                        max={31}
                        value={dayOfMonth}
                        onChange={e => setDayOfMonth(Math.min(31, Math.max(1, parseInt(e.target.value) || 1)))}
                      />
                      <p className="text-xs text-muted-foreground">
                        Runs on the {dayOfMonth}{dayOfMonth === 1 ? "st" : dayOfMonth === 2 ? "nd" : dayOfMonth === 3 ? "rd" : "th"} of each month
                      </p>
                    </div>
                  )}

                  {monthlyMode === "nthWeekday" && (
                    <div className="space-y-3">
                      <div className="flex gap-3 items-end">
                        <div className="space-y-2 flex-1">
                          <Label>Occurrence</Label>
                          <select
                            className="w-full h-10 rounded-lg border bg-background px-3 text-sm"
                            value={nthWeek}
                            onChange={e => setNthWeek(parseInt(e.target.value))}
                          >
                            {NTH_LABELS.map((label, i) => (
                              <option key={i} value={i + 1}>{label}</option>
                            ))}
                          </select>
                        </div>
                        <div className="space-y-2 flex-1">
                          <Label>Day</Label>
                          <select
                            className="w-full h-10 rounded-lg border bg-background px-3 text-sm"
                            value={nthWeekday}
                            onChange={e => setNthWeekday(parseInt(e.target.value))}
                          >
                            {WEEKDAY_LABELS.map((label, i) => (
                              <option key={i} value={i}>{label}</option>
                            ))}
                          </select>
                        </div>
                      </div>
                      <p className="text-xs text-muted-foreground">
                        Runs on the {NTH_LABELS[nthWeek - 1]} {WEEKDAY_LABELS[nthWeekday]} of each month
                      </p>
                    </div>
                  )}

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
