// ─── Schedule Calendar Page ─────────────────────────────────────────
// Month-grid view of all enabled schedules. Each cell shows an indicator
// for the runs falling on that day; clicking a day reveals the full list
// of runs (schedule name → job name + time).

import { useMemo, useState } from "react";
import { Link } from "wouter";
import { useGetScheduleCalendar } from "@workspace/api-client-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Calendar as CalendarIcon, ChevronLeft, ChevronRight, Clock } from "lucide-react";

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

export default function ScheduleCalendar() {
  const today = new Date();
  const [year, setYear] = useState(today.getFullYear());
  const [month, setMonth] = useState(today.getMonth() + 1); // 1-12
  const [selectedDay, setSelectedDay] = useState<number | null>(null);

  const { data: entries = [], isLoading } = useGetScheduleCalendar({ year, month });

  // Group entries by day-of-month for fast lookup in the grid.
  const byDay = useMemo(() => {
    const m = new Map<number, typeof entries>();
    for (const e of entries) {
      const d = new Date(e.datetime);
      // Use local timezone day so the grid matches the user's clock
      if (d.getFullYear() === year && d.getMonth() === month - 1) {
        const day = d.getDate();
        const arr = m.get(day) ?? [];
        arr.push(e);
        m.set(day, arr);
      }
    }
    return m;
  }, [entries, year, month]);

  const monthStart = new Date(year, month - 1, 1);
  const startOffset = monthStart.getDay(); // 0=Sun
  const daysInMonth = new Date(year, month, 0).getDate();

  const cells: Array<{ day: number | null }> = [];
  for (let i = 0; i < startOffset; i++) cells.push({ day: null });
  for (let d = 1; d <= daysInMonth; d++) cells.push({ day: d });
  while (cells.length % 7 !== 0) cells.push({ day: null });

  const prevMonth = () => {
    setSelectedDay(null);
    if (month === 1) { setYear(year - 1); setMonth(12); } else setMonth(month - 1);
  };
  const nextMonth = () => {
    setSelectedDay(null);
    if (month === 12) { setYear(year + 1); setMonth(1); } else setMonth(month + 1);
  };

  const selectedEntries = selectedDay != null ? (byDay.get(selectedDay) ?? []) : [];
  const isToday = (d: number) =>
    today.getFullYear() === year && today.getMonth() === month - 1 && today.getDate() === d;

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight flex items-center gap-3">
            <CalendarIcon className="w-7 h-7 text-primary" />
            Schedule Calendar
          </h1>
          <p className="text-muted-foreground mt-1">Projected schedule runs for the selected month.</p>
        </div>
        <Link href="/scheduler">
          <Button variant="outline">List view</Button>
        </Link>
      </div>

      <Card>
        <CardContent className="p-6">
          <div className="flex items-center justify-between mb-4">
            <Button variant="ghost" size="icon" onClick={prevMonth} aria-label="Previous month">
              <ChevronLeft className="w-4 h-4" />
            </Button>
            <h2 className="text-xl font-semibold" data-testid="calendar-month-title">
              {MONTH_NAMES[month - 1]} {year}
            </h2>
            <Button variant="ghost" size="icon" onClick={nextMonth} aria-label="Next month">
              <ChevronRight className="w-4 h-4" />
            </Button>
          </div>

          <div className="grid grid-cols-7 text-xs uppercase text-muted-foreground border-b border-white/5 pb-2 mb-2">
            {WEEKDAYS.map((d) => <div key={d} className="text-center">{d}</div>)}
          </div>

          <div className="grid grid-cols-7 gap-1">
            {cells.map((c, i) => {
              if (c.day == null) return <div key={i} className="aspect-square" />;
              const runs = byDay.get(c.day) ?? [];
              const isSelected = selectedDay === c.day;
              return (
                <button
                  key={i}
                  onClick={() => setSelectedDay(c.day)}
                  className={`aspect-square rounded-lg border text-sm flex flex-col items-center justify-start p-1 transition-colors ${
                    isSelected
                      ? "border-primary bg-primary/10"
                      : isToday(c.day)
                      ? "border-primary/50"
                      : "border-white/5 hover:border-white/20"
                  }`}
                  data-testid={`calendar-day-${c.day}`}
                >
                  <span className={`text-xs ${isToday(c.day) ? "font-bold text-primary" : ""}`}>{c.day}</span>
                  {runs.length > 0 && (
                    <span className="mt-1 text-[10px] px-1.5 rounded-full bg-primary/20 text-primary">
                      {runs.length}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        </CardContent>
      </Card>

      {selectedDay != null && (
        <Card>
          <CardContent className="p-6">
            <h3 className="font-semibold mb-3">
              Runs on {MONTH_NAMES[month - 1]} {selectedDay}, {year}
            </h3>
            {selectedEntries.length === 0 ? (
              <p className="text-sm text-muted-foreground">No scheduled runs on this day.</p>
            ) : (
              <div className="space-y-2">
                {selectedEntries.map((e, i) => (
                  <div key={i} className="flex items-center justify-between bg-white/[0.02] border border-white/5 rounded-lg p-3">
                    <div className="min-w-0">
                      <p className="font-medium truncate">{e.scheduleName}</p>
                      <p className="text-xs text-muted-foreground truncate">→ {e.jobName}</p>
                    </div>
                    <div className="flex items-center gap-2 text-sm text-muted-foreground shrink-0 ml-3">
                      <Clock className="w-3 h-3" />
                      <span className="font-mono">
                        {new Date(e.datetime).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {isLoading && <p className="text-xs text-muted-foreground">Loading schedule data…</p>}
    </div>
  );
}
