import { useState, useEffect, useMemo } from "react";
import { useLocation, useSearch } from "wouter";
import { useListRouters, useListGroups, useListSnippets, useGetJob, useDryRunJob, customFetch } from "@workspace/api-client-react";
import { useQuery } from "@tanstack/react-query";
import { useJobsMutations } from "@/hooks/use-mutations";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Play, Upload, Code, Target, Table as TableIcon, Monitor, GripVertical, X, Wifi, WifiOff, Clock, ShieldCheck, Search, Eye, AlertTriangle } from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ScriptBuilder, ScriptBlock, buildCombinedScript } from "@/components/script-builder";
import { useDragReorder } from "@/hooks/use-drag-reorder";
import { useToast } from "@/hooks/use-toast";
import { extractTags } from "@/lib/utils";
import type ExcelJS from "exceljs";

// IMPORTANT: these two endpoints are POSTs and the API server's CSRF
// middleware (added in 1.8.0) requires the `X-Requested-With: XMLHttpRequest`
// header on every state-changing /api request. Plain `fetch()` does not set
// that header, so it would 403 silently and the catch-all `if (!res.ok)
// return 0` made the bug invisible — the "unique devices" badge stuck at 0
// and reachability dots stayed grey. `customFetch` from the shared API client
// adds the header automatically, so always use it for /api calls instead of
// the global `fetch`.
// IMPORTANT: customFetch from @workspace/api-client-react returns the
// PARSED RESPONSE BODY (Promise<T>), NOT a Response object. It also throws
// an ApiError on non-2xx so we don't need to check `.ok`. Older code in
// this file treated the return value as a Response (`res.ok`, `res.json()`)
// — that's a bug: `res.ok` is `undefined`, the early-return fires, and the
// hook always resolves to its default (0 / {}). On a non-OK status,
// customFetch throws and react-query catches it, so we wrap the call in
// try/catch and fall back to the same defaults the old code used so the
// UI still degrades gracefully when the user is logged out etc.
function useResolvedDeviceCount(routerIds: number[], groupIds: number[]) {
  return useQuery({
    queryKey: ["resolve-count", routerIds, groupIds],
    queryFn: async () => {
      if (routerIds.length === 0 && groupIds.length === 0) return 0;
      try {
        const data = await customFetch<{ count: number }>(
          `${import.meta.env.BASE_URL}api/jobs/resolve-count`,
          {
            method: "POST",
            body: JSON.stringify({ targetRouterIds: routerIds, targetGroupIds: groupIds }),
          },
        );
        return data.count;
      } catch {
        return 0;
      }
    },
    enabled: routerIds.length > 0 || groupIds.length > 0,
  });
}

function useReachability(routerIds: number[]) {
  return useQuery({
    queryKey: ["reachability", routerIds],
    queryFn: async () => {
      if (routerIds.length === 0) return {} as Record<number, boolean>;
      try {
        return await customFetch<Record<number, boolean>>(
          `${import.meta.env.BASE_URL}api/routers/check-reachability`,
          {
            method: "POST",
            body: JSON.stringify({ routerIds }),
          },
        );
      } catch {
        return {} as Record<number, boolean>;
      }
    },
    enabled: routerIds.length > 0,
    refetchInterval: 10000,
  });
}

interface TargetEntry {
  type: "router" | "group";
  id: number;
  label: string;
  sublabel?: string;
}

export default function NewJob() {
  const [, setLocation] = useLocation();
  const search = useSearch();
  const params = new URLSearchParams(search);
  const copyFromId = params.get("copyFrom");
  const editId = params.get("edit");
  const sourceJobId = copyFromId || editId;
  const isEditMode = !!editId;

  const { toast } = useToast();
  const { createJob, updateJob } = useJobsMutations();

  const { data: routers = [], isSuccess: routersLoaded } = useListRouters();
  const { data: groups = [], isSuccess: groupsLoaded } = useListGroups();
  const { data: snippets = [] } = useListSnippets();

  const { data: sourceJob } = useGetJob(sourceJobId ? parseInt(sourceJobId) : 0, {
    query: { enabled: !!sourceJobId },
  });

  const [name, setName] = useState("");
  const [scriptBlocks, setScriptBlocks] = useState<ScriptBlock[]>([]);
  const [targets, setTargets] = useState<TargetEntry[]>([]);
  const [excelData, setExcelData] = useState<any[]>([]);
  const [autoConfirm, setAutoConfirm] = useState(true);
  const [timeoutSeconds, setTimeoutSeconds] = useState(30);
  const [retryCount, setRetryCount] = useState(0);
  const [retryBackoffSeconds, setRetryBackoffSeconds] = useState(5);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [previewData, setPreviewData] = useState<Array<{ routerId: number; routerName: string; routerIp: string; resolvedScript: string; missingTags: string[] }>>([]);
  const dryRunMut = useDryRunJob();
  const [deviceSearch, setDeviceSearch] = useState("");
  const [groupSearch, setGroupSearch] = useState("");
  const [jobMode, setJobMode] = useState<"run" | "schedule">("run");
  const [populated, setPopulated] = useState(false);

  useEffect(() => {
    if (!sourceJob || populated || !routersLoaded || !groupsLoaded) return;
    setPopulated(true);

    setName(copyFromId ? `${sourceJob.name} (copy)` : sourceJob.name);

    if (sourceJob.scriptCode) {
      setScriptBlocks([{
        instanceId: `imported-${Date.now()}`,
        type: "code",
        code: sourceJob.scriptCode,
      }]);
    }

    if (sourceJob.status === "scheduled") {
      setJobMode("schedule");
    }
    setAutoConfirm(sourceJob.autoConfirm);
    if (sourceJob.timeoutSeconds) setTimeoutSeconds(sourceJob.timeoutSeconds);
    if (typeof sourceJob.retryCount === "number") setRetryCount(sourceJob.retryCount);
    if (typeof sourceJob.retryBackoffSeconds === "number") setRetryBackoffSeconds(sourceJob.retryBackoffSeconds);

    const newTargets: TargetEntry[] = [];
    if (sourceJob.targetRouterIds) {
      for (const rid of sourceJob.targetRouterIds) {
        const r = routers.find(rt => rt.id === rid);
        if (r) newTargets.push({ type: "router", id: r.id, label: r.name, sublabel: r.ipAddress });
      }
    }
    if (sourceJob.targetGroupIds) {
      for (const gid of sourceJob.targetGroupIds) {
        const g = groups.find(gr => gr.id === gid);
        if (g) newTargets.push({ type: "group", id: g.id, label: g.name });
      }
    }
    setTargets(newTargets);

    if (sourceJob.excelData && Array.isArray(sourceJob.excelData)) {
      setExcelData(sourceJob.excelData as any[]);
    }
  }, [sourceJob, populated, routers, groups, routersLoaded, groupsLoaded, copyFromId]);

  // Sort + memoize so the array reference is stable when the contents are
  // stable. Without this the `useResolvedDeviceCount` query key changes on
  // every render (re-renders happen on every poll/reachability tick), the
  // cached result is invalidated, the hook keeps returning its default `0`,
  // and the "X unique devices" badge sticks at "0 unique devices". Sorting
  // also makes [1,2] and [2,1] hash to the same key.
  const selectedRouterIds = useMemo(
    () => targets.filter(t => t.type === "router").map(t => t.id).sort((a, b) => a - b),
    [targets],
  );
  const selectedGroupIds = useMemo(
    () => targets.filter(t => t.type === "group").map(t => t.id).sort((a, b) => a - b),
    [targets],
  );

  const allRouterIdsForReachability = routers.map(r => r.id);
  const { data: reachability = {}, isFetching: isCheckingReachability } = useReachability(allRouterIdsForReachability);

  const { data: resolvedCount = 0, isFetching: isResolvingCount } = useResolvedDeviceCount(
    selectedRouterIds,
    selectedGroupIds
  );

  const combinedScript = buildCombinedScript(scriptBlocks);
  const tags = extractTags(combinedScript);

  const targetDrag = useDragReorder(targets, setTargets);

  const toggleTarget = (type: "router" | "group", id: number, label: string, sublabel?: string) => {
    setTargets(prev => {
      const exists = prev.find(t => t.type === type && t.id === id);
      if (exists) return prev.filter(t => !(t.type === type && t.id === id));
      return [...prev, { type, id, label, sublabel }];
    });
  };

  const isTargetSelected = (type: "router" | "group", id: number) =>
    targets.some(t => t.type === type && t.id === id);

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const isCSV = file.name.toLowerCase().endsWith(".csv");
      const ExcelJSModule = (await import("exceljs")).default;
      const wb = new ExcelJSModule.Workbook();

      if (isCSV) {
        const text = await file.text();
        const buffer = new TextEncoder().encode(text);
        await wb.csv.read(new Blob([buffer]).stream() as any);
      } else {
        const arrayBuffer = await file.arrayBuffer();
        await wb.xlsx.load(arrayBuffer);
      }

      const ws = wb.worksheets[0];
      if (!ws) return;

      const headers: string[] = [];
      ws.getRow(1).eachCell((cell, colNumber) => {
        headers[colNumber - 1] = String(cell.value ?? "").trim();
      });

      const formattedData: Record<string, string>[] = [];
      for (let i = 2; i <= ws.rowCount; i++) {
        const row = ws.getRow(i);
        const obj: Record<string, string> = {};
        let hasValue = false;
        headers.forEach((h, idx) => {
          const val = String(row.getCell(idx + 1).value ?? "").trim();
          obj[h] = val;
          if (val) hasValue = true;
        });
        if (hasValue) formattedData.push(obj);
      }

      setExcelData(formattedData);
      toast({ title: "Data loaded", description: `Loaded ${formattedData.length} rows from file.` });
    } catch {
      toast({ title: "Error parsing file", variant: "destructive" });
    }
  };

  const handleSubmit = async (mode: "run" | "schedule") => {
    if (!name || !combinedScript || targets.length === 0) {
      toast({ title: "Missing fields", description: "Please fill in job name, at least one script block, and at least one target.", variant: "destructive" });
      return;
    }
    // Confirm before firing a "run now" job that will hit a large device set,
    // since there's no undo once SSH commands start landing on production gear.
    if (mode === "run" && !isEditMode && targets.length >= 5) {
      const ok = await confirmDialog({
        title: `Run job on ${targets.length} device${targets.length === 1 ? "" : "s"}?`,
        description: "This will execute the script immediately on every selected device. There is no undo.",
        confirmLabel: "Run now",
        variant: "destructive",
      });
      if (!ok) return;
    }
    setJobMode(mode);
    setIsSubmitting(true);
    try {
      if (isEditMode && editId) {
        const jobId = parseInt(editId);
        await updateJob.mutateAsync({
          id: jobId,
          data: {
            name,
            scriptCode: combinedScript,
            targetRouterIds: selectedRouterIds,
            targetGroupIds: selectedGroupIds,
            excelData: excelData.length > 0 ? excelData : undefined,
            mode: "schedule",
            autoConfirm,
            timeoutSeconds,
            retryCount,
            retryBackoffSeconds,
          },
        });
        toast({ title: "Job updated successfully!" });
        setLocation(`/jobs/${jobId}`);
      } else {
        const res = await createJob.mutateAsync({
          data: {
            name,
            scriptCode: combinedScript,
            targetRouterIds: selectedRouterIds,
            targetGroupIds: selectedGroupIds,
            excelData: excelData.length > 0 ? excelData : undefined,
            mode: mode === "schedule" ? "schedule" : undefined,
            autoConfirm,
            timeoutSeconds,
            retryCount,
            retryBackoffSeconds,
          },
        });

        if (mode === "schedule") {
          toast({ title: "Job template saved! Now configure the schedule." });
          setLocation(`/scheduler/new?jobId=${res.id}`);
        } else {
          toast({ title: "Job started successfully!" });
          setLocation(`/jobs/${res.id}`);
        }
      }
    } catch (e: any) {
      toast({ title: isEditMode ? "Failed to update job" : "Failed to start job", description: e.message, variant: "destructive" });
      setIsSubmitting(false);
    }
  };

  return (
    <div className="max-w-4xl mx-auto space-y-6 pb-20">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">
          {isEditMode ? "Edit Batch Job" : copyFromId ? "Copy Batch Job" : "Create Batch Job"}
        </h1>
        <p className="text-muted-foreground mt-1">
          {isEditMode ? "Modify and re-submit this job." : "Configure and launch a script across multiple devices."}
        </p>
      </div>

      <Card className="glass-panel">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-xl">
            <Code className="w-5 h-5 text-primary" /> 1. Script Configuration
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="space-y-2">
            <Label>Job Name *</Label>
            <Input value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Firmware Update Q3" />
          </div>

          <ScriptBuilder
            blocks={scriptBlocks}
            onChange={setScriptBlocks}
            snippets={snippets}
          />
        </CardContent>
      </Card>

      <Card className="glass-panel">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-xl">
            <Target className="w-5 h-5 text-primary" /> 2. Target Selection *
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
            <div className="space-y-3">
              <Label className="text-base">Devices</Label>
              <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                <Input
                  placeholder="Search devices..."
                  value={deviceSearch}
                  onChange={e => setDeviceSearch(e.target.value)}
                  className="pl-9 bg-black/40 border-white/5 h-9 text-sm"
                />
              </div>
              <div className="h-48 overflow-y-auto border border-white/5 rounded-xl p-2 bg-black/20 space-y-1">
                {(() => {
                  const filtered = routers.filter(r => {
                    if (!deviceSearch) return true;
                    const s = deviceSearch.toLowerCase();
                    return r.name.toLowerCase().includes(s) || r.ipAddress.toLowerCase().includes(s) || (r.description ?? "").toLowerCase().includes(s);
                  });
                  return filtered.length === 0 ? (
                    <p className="text-xs text-muted-foreground p-2 italic">
                      {routers.length === 0 ? "No devices configured yet." : "No matching devices"}
                    </p>
                  ) : (
                    filtered.map(r => {
                      const isReachable = reachability[r.id];
                      const hasStatus = r.id in reachability;
                      return (
                        <label key={r.id} className="flex items-center gap-3 p-2 hover:bg-white/5 rounded-lg cursor-pointer">
                          <input
                            type="checkbox"
                            className="w-4 h-4 rounded border-white/20 bg-black/50 text-primary accent-primary"
                            checked={isTargetSelected("router", r.id)}
                            onChange={() => toggleTarget("router", r.id, r.name, r.ipAddress)}
                          />
                          {hasStatus ? (
                            isReachable ? (
                              <span className="w-2 h-2 rounded-full bg-emerald-400 shrink-0" title="Reachable" />
                            ) : (
                              <span className="w-2 h-2 rounded-full bg-red-400 shrink-0" title="Unreachable" />
                            )
                          ) : (
                            <span className="w-2 h-2 rounded-full bg-muted-foreground/30 shrink-0 animate-pulse" title="Checking..." />
                          )}
                          <span className="text-sm font-medium">{r.name} <span className="text-muted-foreground font-mono text-xs ml-1">({r.ipAddress})</span></span>
                        </label>
                      );
                    })
                  );
                })()}
              </div>
            </div>

            <div className="space-y-3">
              <Label className="text-base">Device Groups</Label>
              <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                <Input
                  placeholder="Search groups..."
                  value={groupSearch}
                  onChange={e => setGroupSearch(e.target.value)}
                  className="pl-9 bg-black/40 border-white/5 h-9 text-sm"
                />
              </div>
              <div className="h-48 overflow-y-auto border border-white/5 rounded-xl p-2 bg-black/20 space-y-1">
                {(() => {
                  const filtered = groups.filter(g => {
                    if (!groupSearch) return true;
                    const s = groupSearch.toLowerCase();
                    return g.name.toLowerCase().includes(s) || (g.description ?? "").toLowerCase().includes(s);
                  });
                  return filtered.length === 0 ? (
                    <p className="text-xs text-muted-foreground p-2 italic">
                      {groups.length === 0 ? "No groups configured yet." : "No matching groups"}
                    </p>
                  ) : (
                    filtered.map(g => (
                      <label key={g.id} className="flex items-center gap-3 p-2 hover:bg-white/5 rounded-lg cursor-pointer">
                        <input
                          type="checkbox"
                          className="w-4 h-4 rounded border-white/20 bg-black/50 text-primary accent-primary"
                          checked={isTargetSelected("group", g.id)}
                          onChange={() => toggleTarget("group", g.id, g.name)}
                        />
                        <span className="text-sm font-medium">{g.name}</span>
                      </label>
                    ))
                  );
                })()}
              </div>
            </div>
          </div>

          {targets.length > 0 && (
            <div className="space-y-3">
              <div className="flex justify-between items-center flex-wrap gap-2">
                <Label className="text-base">Execution Order (drag to reorder)</Label>
                <div className="flex items-center gap-4">
                  {selectedRouterIds.length > 0 && Object.keys(reachability).length > 0 && (() => {
                    const onlineCount = selectedRouterIds.filter(id => reachability[id] === true).length;
                    const offlineCount = selectedRouterIds.filter(id => reachability[id] === false).length;
                    return (
                      <div className="flex items-center gap-3 text-xs">
                        <span className="flex items-center gap-1 text-emerald-400"><Wifi className="w-3 h-3" />{onlineCount}</span>
                        <span className="flex items-center gap-1 text-red-400"><WifiOff className="w-3 h-3" />{offlineCount}</span>
                      </div>
                    );
                  })()}
                  <div className="flex items-center gap-2">
                    <Monitor className="w-4 h-4 text-primary" />
                    <span className="text-sm font-semibold text-primary">
                      {isResolvingCount ? "Resolving..." : `${resolvedCount} unique device${resolvedCount !== 1 ? "s" : ""}`}
                    </span>
                  </div>
                </div>
              </div>
              <div className="space-y-1 border border-white/5 rounded-xl bg-black/20 p-2">
                {targets.map((t, idx) => {
                  const routerReachable = t.type === "router" ? reachability[t.id] : undefined;
                  const routerHasStatus = t.type === "router" && t.id in reachability;
                  return (
                    <div
                      key={`${t.type}-${t.id}`}
                      draggable
                      onDragStart={() => targetDrag.onDragStart(idx)}
                      onDragOver={(e) => targetDrag.onDragOver(e, idx)}
                      onDrop={targetDrag.onDrop}
                      className="flex items-center gap-2 p-2.5 rounded-lg bg-black/30 border border-white/5 hover:border-primary/30 transition-colors group cursor-grab active:cursor-grabbing"
                    >
                      <GripVertical className="w-4 h-4 text-muted-foreground/50 group-hover:text-muted-foreground shrink-0" />
                      <span className="text-xs text-muted-foreground font-mono w-5 shrink-0">{idx + 1}.</span>
                      {t.type === "router" && (
                        routerHasStatus ? (
                          routerReachable ? (
                            <Wifi className="w-3.5 h-3.5 text-emerald-400 shrink-0" title="SSH port reachable" />
                          ) : (
                            <WifiOff className="w-3.5 h-3.5 text-red-400 shrink-0" title="SSH port unreachable" />
                          )
                        ) : (
                          <span className="w-3.5 h-3.5 rounded-full bg-muted-foreground/30 shrink-0 animate-pulse" title="Checking..." />
                        )
                      )}
                      <Badge variant={t.type === "router" ? "outline" : "secondary"} className="text-xs shrink-0">
                        {t.type === "router" ? "Device" : "Group"}
                      </Badge>
                      <span className="text-sm font-medium flex-1 truncate">{t.label}</span>
                      {t.sublabel && <span className="text-xs text-muted-foreground font-mono shrink-0">{t.sublabel}</span>}
                      <button
                        onClick={() => toggleTarget(t.type, t.id, t.label, t.sublabel)}
                        className="text-muted-foreground hover:text-destructive transition-colors shrink-0"
                      >
                        <X className="w-4 h-4" />
                      </button>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      <Card className="glass-panel">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-xl">
            <TableIcon className="w-5 h-5 text-primary" /> 3. Data Substitution (Optional)
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-muted-foreground mb-4">
            Upload an Excel or CSV file to replace variables in your script.
            The file should have column headers matching your tags (e.g. <span className="font-mono text-primary">HOSTNAME</span>).
            Include a <span className="font-mono text-primary">ROUTER_IP</span> or <span className="font-mono text-primary">ROUTER_NAME</span> column to match rows to specific routers.
          </p>

          <div className="border-2 border-dashed border-white/10 rounded-xl p-8 text-center bg-black/20 hover:bg-white/5 transition-colors relative">
            <input
              type="file"
              accept=".csv,.xlsx,.xls"
              onChange={handleFileUpload}
              className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
            />
            <Upload className="w-8 h-8 text-muted-foreground mx-auto mb-2" />
            <p className="font-medium">Click or drag file to upload</p>
            <p className="text-xs text-muted-foreground mt-1">Supports .csv, .xlsx</p>
          </div>

          {excelData.length > 0 && (
            <div className="mt-4">
              <div className="flex justify-between items-center mb-2">
                <span className="text-sm font-medium text-emerald-400">Data Loaded ({excelData.length} rows)</span>
                <Button variant="ghost" size="sm" onClick={() => setExcelData([])} className="h-8 text-destructive">Clear Data</Button>
              </div>
              <div className="overflow-x-auto rounded-xl border border-white/5">
                <table className="w-full text-xs text-left">
                  <thead className="bg-black/40 text-muted-foreground">
                    <tr>
                      {Object.keys(excelData[0]).map(k => <th key={k} className="px-4 py-2 font-mono">{k}</th>)}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border/50">
                    {excelData.slice(0, 3).map((row, i) => (
                      <tr key={i} className="bg-background/50">
                        {Object.values(row).map((v: any, j) => <td key={j} className="px-4 py-2">{v}</td>)}
                      </tr>
                    ))}
                  </tbody>
                </table>
                {excelData.length > 3 && <div className="p-2 text-center text-xs text-muted-foreground bg-black/20">...and {excelData.length - 3} more rows</div>}
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      <Card className="glass-panel">
        <CardContent className="py-4">
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => setAutoConfirm(!autoConfirm)}
              className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 ${autoConfirm ? 'bg-teal-500' : 'bg-slate-600'}`}
            >
              <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${autoConfirm ? 'translate-x-6' : 'translate-x-1'}`} />
            </button>
            <div className="flex items-center gap-2">
              <ShieldCheck className="w-4 h-4 text-teal-400" />
              <Label className="text-sm font-medium cursor-pointer" onClick={() => setAutoConfirm(!autoConfirm)}>
                Auto-confirm SSH prompts
              </Label>
            </div>
            <span className="text-xs text-slate-400 ml-auto hidden sm:block">
              Automatically answer "yes" to confirmation prompts during SSH execution
            </span>
          </div>
        </CardContent>
      </Card>

      <Card className="glass-panel">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-xl">
            <ShieldCheck className="w-5 h-5 text-primary" /> 4. Reliability
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div className="space-y-2">
              <Label className="text-sm">Timeout (seconds)</Label>
              <Input
                type="number"
                min={1}
                max={3600}
                value={timeoutSeconds}
                onChange={(e) => setTimeoutSeconds(Math.max(1, Math.min(3600, parseInt(e.target.value) || 30)))}
              />
              <p className="text-xs text-muted-foreground">Per-device SSH hard limit (1–3600).</p>
            </div>
            <div className="space-y-2">
              <Label className="text-sm">Retries on failure</Label>
              <Input
                type="number"
                min={0}
                max={10}
                value={retryCount}
                onChange={(e) => setRetryCount(Math.max(0, Math.min(10, parseInt(e.target.value) || 0)))}
              />
              <p className="text-xs text-muted-foreground">Only retries connection-level failures (0–10).</p>
            </div>
            <div className="space-y-2">
              <Label className="text-sm">Retry back-off (seconds)</Label>
              <Input
                type="number"
                min={0}
                max={300}
                value={retryBackoffSeconds}
                onChange={(e) => setRetryBackoffSeconds(Math.max(0, Math.min(300, parseInt(e.target.value) || 0)))}
                disabled={retryCount === 0}
              />
              <p className="text-xs text-muted-foreground">Wait between attempts.</p>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card className="glass-panel">
        <CardContent className="py-4">
          <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-end gap-3">
            <Button
              size="lg"
              variant="outline"
              type="button"
              onClick={async () => {
                try {
                  // Send the same payload shape we'd send on submit, but with
                  // mode="run" since the server only cares about routers/script.
                  const scriptCode = buildCombinedScript(scriptBlocks);
                  const data = await dryRunMut.mutateAsync({
                    data: {
                      name: name || "preview",
                      scriptCode,
                      targetRouterIds: selectedRouterIds,
                      targetGroupIds: selectedGroupIds,
                      excelData: excelData.length > 0 ? (excelData as any) : undefined,
                      mode: "run" as const,
                      autoConfirm,
                    } as any,
                  });
                  setPreviewData(data as any);
                  setPreviewOpen(true);
                } catch (err: any) {
                  toast({ title: "Preview failed", description: String(err?.message || err), variant: "destructive" });
                }
              }}
              disabled={dryRunMut.isPending || (selectedRouterIds.length === 0 && selectedGroupIds.length === 0)}
              className="text-lg gap-2"
              data-testid="preview-button"
            >
              {dryRunMut.isPending ? "Resolving…" : <><Eye className="w-5 h-5" /> Preview</>}
            </Button>
            {isEditMode ? (
              <Button
                size="lg"
                onClick={() => handleSubmit("schedule")}
                disabled={isSubmitting}
                className="text-lg gap-2 shadow-[0_0_20px_rgba(45,212,191,0.3)]"
              >
                {isSubmitting ? "Saving..." : <><Clock className="w-5 h-5" /> Save Changes</>}
              </Button>
            ) : (
              <>
                <Button
                  size="lg"
                  variant="outline"
                  onClick={() => handleSubmit("schedule")}
                  disabled={isSubmitting}
                  className="text-lg gap-2"
                >
                  {isSubmitting && jobMode === "schedule"
                    ? "Saving..."
                    : <><Clock className="w-5 h-5" /> Save & Schedule</>
                  }
                </Button>
                <Button
                  size="lg"
                  onClick={() => handleSubmit("run")}
                  disabled={isSubmitting}
                  className="text-lg gap-2 shadow-[0_0_20px_rgba(45,212,191,0.3)]"
                >
                  {isSubmitting && jobMode === "run"
                    ? "Starting..."
                    : <><Play className="w-5 h-5 fill-current" /> Save & Run</>
                  }
                </Button>
              </>
            )}
          </div>
        </CardContent>
      </Card>

      <Dialog open={previewOpen} onOpenChange={setPreviewOpen}>
        <DialogContent className="max-w-4xl max-h-[80vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Eye className="w-5 h-5 text-primary" /> Preview ({previewData.length} device{previewData.length !== 1 ? "s" : ""})
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            {previewData.length === 0 && (
              <p className="text-muted-foreground text-sm">No devices resolved.</p>
            )}
            {previewData.map((p) => {
              // Escape HTML first (defends against XSS — script bodies and
              // Excel-substituted values can contain arbitrary characters),
              // then highlight any unresolved {{TAG}} placeholders so the
              // operator can spot missing substitutions before firing.
              const escaped = p.resolvedScript
                .replace(/&/g, "&amp;")
                .replace(/</g, "&lt;")
                .replace(/>/g, "&gt;");
              const html = escaped.replace(
                /\{\{\s*([A-Za-z0-9_-]+)\s*\}\}/g,
                (m) => `<mark class="bg-destructive/30 text-destructive px-1 rounded">${m}</mark>`,
              );
              return (
                <div key={p.routerId} className="border border-white/5 rounded-lg overflow-hidden">
                  <div className="bg-white/[0.02] px-4 py-2 flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <div className="font-medium truncate">{p.routerName}</div>
                      <div className="text-xs text-muted-foreground font-mono">{p.routerIp}</div>
                    </div>
                    {p.missingTags.length > 0 && (
                      <Badge variant="destructive" className="gap-1 shrink-0">
                        <AlertTriangle className="w-3 h-3" />
                        Missing: {p.missingTags.join(", ")}
                      </Badge>
                    )}
                  </div>
                  <pre
                    className="bg-black/40 text-xs p-3 overflow-x-auto whitespace-pre-wrap font-mono"
                    dangerouslySetInnerHTML={{ __html: html }}
                  />
                </div>
              );
            })}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
