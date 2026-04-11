import { useState, useEffect } from "react";
import { useLocation, useSearch } from "wouter";
import { useListRouters, useListGroups, useListSnippets, useGetJob } from "@workspace/api-client-react";
import { useQuery } from "@tanstack/react-query";
import { useJobsMutations } from "@/hooks/use-mutations";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Play, Upload, Code, Target, Table as TableIcon, Monitor, GripVertical, X, Wifi, WifiOff, Clock, ShieldCheck, Search } from "lucide-react";
import { ScriptBuilder, ScriptBlock, buildCombinedScript } from "@/components/script-builder";
import { useDragReorder } from "@/hooks/use-drag-reorder";
import { useToast } from "@/hooks/use-toast";
import { extractTags } from "@/lib/utils";
import * as XLSX from "xlsx";

function useResolvedDeviceCount(routerIds: number[], groupIds: number[]) {
  return useQuery({
    queryKey: ["resolve-count", routerIds, groupIds],
    queryFn: async () => {
      if (routerIds.length === 0 && groupIds.length === 0) return 0;
      const res = await fetch(`${import.meta.env.BASE_URL}api/jobs/resolve-count`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ targetRouterIds: routerIds, targetGroupIds: groupIds }),
      });
      if (!res.ok) return 0;
      const data = await res.json();
      return data.count as number;
    },
    enabled: routerIds.length > 0 || groupIds.length > 0,
  });
}

function useReachability(routerIds: number[]) {
  return useQuery({
    queryKey: ["reachability", routerIds],
    queryFn: async () => {
      if (routerIds.length === 0) return {} as Record<number, boolean>;
      const res = await fetch(`${import.meta.env.BASE_URL}api/routers/check-reachability`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ routerIds }),
      });
      if (!res.ok) return {} as Record<number, boolean>;
      return (await res.json()) as Record<number, boolean>;
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
  const [isSubmitting, setIsSubmitting] = useState(false);
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

  const selectedRouterIds = targets.filter(t => t.type === "router").map(t => t.id);
  const selectedGroupIds = targets.filter(t => t.type === "group").map(t => t.id);

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

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (evt) => {
      try {
        const bstr = evt.target?.result;
        const wb = XLSX.read(bstr, { type: "binary" });
        const ws = wb.Sheets[wb.SheetNames[0]];
        const data = XLSX.utils.sheet_to_json(ws);
        const formattedData = data.map((row: any) => {
          const newRow: any = {};
          Object.keys(row).forEach(k => { newRow[k] = String(row[k]); });
          return newRow;
        });
        setExcelData(formattedData);
        toast({ title: "Data loaded", description: `Loaded ${formattedData.length} rows from file.` });
      } catch {
        toast({ title: "Error parsing file", variant: "destructive" });
      }
    };
    reader.readAsBinaryString(file);
  };

  const handleSubmit = async (mode: "run" | "schedule") => {
    if (!name || !combinedScript || targets.length === 0) {
      toast({ title: "Missing fields", description: "Please fill in job name, at least one script block, and at least one target.", variant: "destructive" });
      return;
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
        <CardContent className="py-4">
          <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-end gap-3">
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
    </div>
  );
}
