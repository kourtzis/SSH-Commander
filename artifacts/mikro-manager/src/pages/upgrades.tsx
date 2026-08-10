import { useState, useMemo } from "react";
import {
  useGetUpgradeOverview,
  useListUpgradeRuns,
  useCreateUpgradeRun,
  useGetUpgradeRun,
  useCancelUpgradeRun,
  useDeleteUpgradeRun,
  getListUpgradeRunsQueryKey,
  getGetUpgradeOverviewQueryKey,
  getGetUpgradeRunQueryKey
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/contexts/auth-context";
import { useConfirm } from "@/components/confirm-dialog";
import { TargetSelector } from "@/components/fleet/target-selector";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { 
  Rocket, Plus, Play, StopCircle, Trash2, CheckCircle2, 
  XCircle, AlertTriangle, Loader2, ArrowRight, Server, FileText, Activity
} from "lucide-react";
import { formatDate } from "@/lib/utils";

export default function Upgrades() {
  const { user } = useAuth();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const confirm = useConfirm();

  const { data: overview = [], isLoading: isOverviewLoading } = useGetUpgradeOverview();
  const { data: runs = [], isLoading: isRunsLoading } = useListUpgradeRuns();
  
  const [selectedRunId, setSelectedRunId] = useState<number | null>(null);
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<"runs" | "fleet">("runs");

  const { data: selectedRun, isLoading: isRunLoading } = useGetUpgradeRun(selectedRunId || 0, {
    query: { 
      enabled: !!selectedRunId, 
      queryKey: getGetUpgradeRunQueryKey(selectedRunId || 0),
      refetchInterval: (query: any) => query.state.data?.status === "running" ? 2500 : false
    }
  });

  const cancelMut = useCancelUpgradeRun();
  const deleteMut = useDeleteUpgradeRun();

  const handleCancel = async (id: number) => {
    if (!await confirm({ title: "Cancel Upgrade Run", description: "In-flight devices will finish. Pending devices will be skipped. Continue?", variant: "destructive" })) return;
    try {
      await cancelMut.mutateAsync({ id });
      toast({ title: "Run cancelled" });
      queryClient.invalidateQueries({ queryKey: getGetUpgradeRunQueryKey(id) });
      queryClient.invalidateQueries({ queryKey: getListUpgradeRunsQueryKey() });
    } catch (err: any) {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    }
  };

  const handleDelete = async (id: number, e: React.MouseEvent) => {
    e.stopPropagation();
    if (!await confirm({ title: "Delete Upgrade Run", description: "Remove this run from history? This cannot be undone.", variant: "destructive" })) return;
    try {
      await deleteMut.mutateAsync({ id });
      toast({ title: "Run deleted" });
      if (selectedRunId === id) setSelectedRunId(null);
      queryClient.invalidateQueries({ queryKey: getListUpgradeRunsQueryKey() });
    } catch (err: any) {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    }
  };

  const getStatusColor = (status: string) => {
    switch (status) {
      case "completed": return "text-emerald-400";
      case "failed": return "text-destructive";
      case "running": return "text-primary";
      case "cancelled": return "text-amber-400";
      default: return "text-muted-foreground";
    }
  };

  const getTaskStatusBadge = (status: string) => {
    switch (status) {
      case "pending": return <Badge variant="outline" className="text-muted-foreground bg-white/5 border-white/10">Pending</Badge>;
      case "backing_up": return <Badge variant="outline" className="text-primary bg-primary/10 border-primary/30">Backing Up...</Badge>;
      case "upgrading": return <Badge variant="outline" className="text-primary bg-primary/10 border-primary/30">Upgrading...</Badge>;
      case "rebooting": return <Badge variant="outline" className="text-amber-400 bg-amber-400/10 border-amber-400/30">Rebooting...</Badge>;
      case "verifying": return <Badge variant="outline" className="text-primary bg-primary/10 border-primary/30">Verifying...</Badge>;
      case "success": return <Badge variant="outline" className="text-emerald-400 bg-emerald-500/10 border-emerald-500/30">Success</Badge>;
      case "failed": return <Badge variant="outline" className="text-destructive bg-destructive/10 border-destructive/30">Failed</Badge>;
      case "skipped": return <Badge variant="outline" className="text-muted-foreground bg-white/5 border-white/10">Skipped</Badge>;
      default: return <Badge variant="outline">{status}</Badge>;
    }
  };

  return (
    <div className="flex flex-col h-[calc(100vh-6rem)] -m-2 sm:-m-4 md:-m-6 lg:-m-8">
      {/* Header */}
      <div className="px-6 py-5 border-b border-border/50 bg-background/50 backdrop-blur-sm z-10 flex-none flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight flex items-center gap-3">
            <Rocket className="w-6 h-6 text-primary" />
            Upgrade Orchestrator
          </h1>
          <p className="text-muted-foreground text-sm mt-1">Deploy RouterOS firmware updates across the fleet with pre-flight snapshots.</p>
        </div>
        <Button onClick={() => setIsCreateOpen(true)} className="gap-2">
          <Plus className="w-4 h-4" /> Start Upgrade Run
        </Button>
      </div>

      <div className="flex flex-1 min-h-0">
        <div className="w-full flex">
          <div className="w-1/3 border-r border-border/50 flex flex-col bg-card/10">
            <div className="p-4 border-b border-border/50">
              <div className="flex bg-black/40 rounded-lg p-1 text-muted-foreground text-sm font-medium">
                <button 
                  className={`flex-1 py-1.5 rounded-md transition-colors ${activeTab === "runs" ? "bg-background text-foreground shadow" : "hover:text-foreground"}`}
                  onClick={() => setActiveTab("runs")}
                >
                  Runs
                </button>
                <button 
                  className={`flex-1 py-1.5 rounded-md transition-colors ${activeTab === "fleet" ? "bg-background text-foreground shadow" : "hover:text-foreground"}`}
                  onClick={() => setActiveTab("fleet")}
                >
                  Fleet OS Versions
                </button>
              </div>
            </div>
            
            {activeTab === "runs" && (
              <div className="flex-1 min-h-0 mt-0 flex flex-col">
                <div className="flex-1 overflow-y-auto">
                  {isRunsLoading ? (
                    <div className="p-4 flex justify-center"><Loader2 className="w-6 h-6 animate-spin text-muted-foreground" /></div>
                  ) : runs.length === 0 ? (
                  <div className="p-8 text-center text-muted-foreground text-sm">
                    No upgrade runs yet.
                  </div>
                ) : (
                  <div className="p-2 space-y-1">
                    {runs.map((run: any) => {
                      const isSelected = selectedRunId === run.id;
                      return (
                        <button
                          key={run.id}
                          onClick={() => setSelectedRunId(run.id)}
                          className={`w-full text-left p-3 rounded-lg border transition-all ${
                            isSelected 
                              ? "bg-primary/10 border-primary/30" 
                              : "bg-transparent border-transparent hover:bg-white/5 hover:border-white/10"
                          }`}
                        >
                          <div className="flex justify-between items-start mb-1">
                            <span className="font-medium truncate pr-2">{run.name}</span>
                            {user?.role === "admin" && run.status !== "running" && (
                              <Button variant="ghost" size="icon" className="w-6 h-6 rounded-md hover:bg-destructive/10 shrink-0" onClick={(e) => handleDelete(run.id, e)}>
                                <Trash2 className="w-3 h-3 text-destructive" />
                              </Button>
                            )}
                          </div>
                          <div className="flex items-center gap-2 mb-2">
                            <span className={`text-xs font-semibold capitalize ${getStatusColor(run.status)}`}>
                              {run.status}
                            </span>
                            <span className="text-[10px] text-muted-foreground">•</span>
                            <span className="text-xs text-muted-foreground">{formatDate(run.createdAt)}</span>
                          </div>
                          <div className="flex items-center gap-3 text-xs">
                            <span className="text-muted-foreground">{run.totalTasks} devices</span>
                            {run.failedTasks > 0 && <span className="text-destructive">{run.failedTasks} failed</span>}
                            {run.status === "running" && <span className="text-primary">{run.completedTasks} done</span>}
                          </div>
                        </button>
                      );
                    })}
                  </div>
                )}
                </div>
              </div>
            )}

            {activeTab === "fleet" && (
              <div className="flex-1 min-h-0 mt-0 flex flex-col">
                <div className="flex-1 overflow-y-auto">
                  {isOverviewLoading ? (
                    <div className="p-4 flex justify-center"><Loader2 className="w-6 h-6 animate-spin text-muted-foreground" /></div>
                  ) : overview.length === 0 ? (
                  <div className="p-8 text-center text-muted-foreground text-sm">
                    No fingerprinted devices found.
                  </div>
                ) : (
                  <div className="p-4 space-y-4">
                    {overview.map((group: any, i: number) => (
                      <div key={i} className="border border-white/5 rounded-lg bg-black/20 overflow-hidden">
                        <div className="px-3 py-2 bg-black/40 border-b border-white/5 flex items-center justify-between">
                          <span className="font-mono text-sm text-primary/80">
                            {group.osVersion || "Unknown OS"}
                          </span>
                          <Badge variant="outline" className="text-xs">{group.count} devices</Badge>
                        </div>
                        <div className="p-2 max-h-[200px] overflow-y-auto space-y-1">
                          {group.routers.map((r: any) => (
                            <div key={r.id} className="flex justify-between items-center px-2 py-1 text-xs hover:bg-white/5 rounded">
                              <span className="truncate pr-2">{r.name}</span>
                              <span className="text-muted-foreground font-mono shrink-0">{r.ipAddress}</span>
                            </div>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
                </div>
              </div>
            )}
          </div>

          <div className="w-2/3 flex flex-col bg-background relative">
            {selectedRun ? (
              <>
                <div className="p-6 flex-none border-b border-border/50 bg-card/20">
                  <div className="flex justify-between items-start">
                    <div>
                      <h2 className="text-xl font-bold flex items-center gap-3">
                        {selectedRun.name}
                        <Badge variant="outline" className={`capitalize ${getStatusColor(selectedRun.status)} border-current bg-current/10`}>
                          {selectedRun.status === "running" && <Loader2 className="w-3 h-3 mr-1 animate-spin inline-block" />}
                          {selectedRun.status}
                        </Badge>
                      </h2>
                      <p className="text-sm text-muted-foreground mt-1">
                        Started at {formatDate(selectedRun.createdAt)} {selectedRun.completedAt ? `• Finished at ${formatDate(selectedRun.completedAt)}` : ''}
                      </p>
                    </div>
                    {selectedRun.status === "running" && (
                      <Button variant="destructive" onClick={() => handleCancel(selectedRun.id)} className="gap-2">
                        <StopCircle className="w-4 h-4" /> Cancel Run
                      </Button>
                    )}
                  </div>
                  
                  {/* Progress Bar */}
                  <div className="mt-6">
                    <div className="flex justify-between text-xs mb-1.5 font-medium">
                      <span className="text-muted-foreground">Overall Progress</span>
                      <span className="text-primary">{selectedRun.completedTasks + selectedRun.failedTasks} / {selectedRun.totalTasks}</span>
                    </div>
                    <div className="h-2 bg-black/60 rounded-full overflow-hidden flex">
                      {selectedRun.totalTasks > 0 && (
                        <>
                          <div 
                            className="h-full bg-emerald-500 transition-all duration-500"
                            style={{ width: `${(selectedRun.completedTasks / selectedRun.totalTasks) * 100}%` }}
                          />
                          <div 
                            className="h-full bg-destructive transition-all duration-500"
                            style={{ width: `${(selectedRun.failedTasks / selectedRun.totalTasks) * 100}%` }}
                          />
                        </>
                      )}
                    </div>
                  </div>
                </div>

                <div className="flex-1 overflow-y-auto">
                  <div className="p-6">
                    <div className="space-y-4">
                      {selectedRun.tasks.map((task: any) => (
                        <div key={task.id} className="border border-white/5 rounded-lg bg-black/20 overflow-hidden group">
                          <div className="px-4 py-3 flex items-center justify-between bg-black/20 group-hover:bg-white/[0.02] transition-colors">
                            <div className="flex items-center gap-4">
                              <div className="w-10 flex justify-center">
                                {task.status === "success" ? <CheckCircle2 className="w-5 h-5 text-emerald-400" /> :
                                 task.status === "failed" ? <XCircle className="w-5 h-5 text-destructive" /> :
                                 task.status === "skipped" ? <StopCircle className="w-5 h-5 text-muted-foreground" /> :
                                 task.status === "pending" ? <Activity className="w-5 h-5 text-muted-foreground/30" /> :
                                 <Loader2 className="w-5 h-5 text-primary animate-spin" />}
                              </div>
                              <div>
                                <div className="font-medium text-sm">{task.routerName}</div>
                                <div className="text-xs text-muted-foreground font-mono">{task.routerIp}</div>
                              </div>
                            </div>
                            
                            <div className="flex items-center gap-6">
                              {(task.oldVersion || task.newVersion) && (
                                <div className="flex items-center gap-2 text-xs font-mono">
                                  <span className="text-muted-foreground">{task.oldVersion || "?"}</span>
                                  <ArrowRight className="w-3 h-3 text-muted-foreground" />
                                  <span className="text-primary">{task.newVersion || "?"}</span>
                                </div>
                              )}
                              <div className="w-28 flex justify-end">
                                {getTaskStatusBadge(task.status)}
                              </div>
                            </div>
                          </div>
                          
                          {(task.errorMessage || task.log) && (
                            <div className="px-4 py-3 border-t border-white/5 bg-black/40">
                              {task.errorMessage && (
                                <div className="text-xs text-destructive mb-2 flex items-start gap-1.5 bg-destructive/10 p-2 rounded">
                                  <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
                                  <span className="font-mono">{task.errorMessage}</span>
                                </div>
                              )}
                              {task.log && (
                                <details className="text-xs font-mono text-muted-foreground/70">
                                  <summary className="cursor-pointer hover:text-muted-foreground py-1">View deployment log</summary>
                                  <pre className="mt-2 p-2 bg-black/60 rounded border border-white/5 whitespace-pre-wrap">
                                    {task.log}
                                  </pre>
                                </details>
                              )}
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              </>
            ) : (
              <div className="flex-1 flex flex-col items-center justify-center text-muted-foreground p-8 text-center">
                <Rocket className="w-16 h-16 text-muted-foreground/20 mb-4" />
                <p className="text-lg font-medium text-foreground mb-1">Select an Upgrade Run</p>
                <p className="max-w-sm">Choose a run from the list to view per-device pipeline progress and logs.</p>
              </div>
            )}
          </div>
        </div>
      </div>

      <CreateRunModal open={isCreateOpen} onOpenChange={setIsCreateOpen} />
    </div>
  );
}

function CreateRunModal({ open, onOpenChange }: { open: boolean, onOpenChange: (o: boolean) => void }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const createMut = useCreateUpgradeRun();

  const [name, setName] = useState("");
  const [routerIds, setRouterIds] = useState<number[]>([]);
  const [groupIds, setGroupIds] = useState<number[]>([]);
  const [preBackup, setPreBackup] = useState(true);

  // Reset on open
  useMemo(() => {
    if (open) {
      setName("");
      setRouterIds([]);
      setGroupIds([]);
      setPreBackup(true);
    }
  }, [open]);

  const handleStart = async () => {
    if (routerIds.length === 0 && groupIds.length === 0) {
      toast({ title: "Select targets", description: "Choose at least one device or group to upgrade.", variant: "destructive" });
      return;
    }

    try {
      await createMut.mutateAsync({
        data: {
          name: name.trim() || undefined,
          routerIds,
          groupIds,
          preBackup
        }
      });
      toast({ title: "Upgrade run started" });
      queryClient.invalidateQueries({ queryKey: getListUpgradeRunsQueryKey() });
      onOpenChange(false);
    } catch (err: any) {
      toast({ title: "Error starting run", description: err.message, variant: "destructive" });
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[90vh] flex flex-col">
        <DialogHeader>
          <DialogTitle>Start Upgrade Run</DialogTitle>
          <DialogDescription>
            Schedule a fleet-wide RouterOS update. Devices will download the latest stable firmware, reboot, and verify.
          </DialogDescription>
        </DialogHeader>
        <div className="flex-1 overflow-y-auto space-y-6 py-4 pr-1">
          <div className="space-y-2">
            <Label>Run Name (Optional)</Label>
            <Input 
              value={name} 
              onChange={(e) => setName(e.target.value)} 
              placeholder="e.g. Core Routers Q3 Update" 
            />
          </div>

          <div className="space-y-2">
            <Label>Target Devices</Label>
            <TargetSelector 
              selectedRouterIds={routerIds}
              selectedGroupIds={groupIds}
              onChange={(r, g) => { setRouterIds(r); setGroupIds(g); }}
            />
          </div>

          <div className="flex items-center justify-between p-4 bg-card/50 rounded-lg border border-white/5">
            <div className="space-y-0.5">
              <Label className="text-base flex items-center gap-2">
                <FileText className="w-4 h-4 text-primary" /> Pre-Flight Backup
              </Label>
              <div className="text-sm text-muted-foreground">Snapshot configuration exports before attempting upgrade.</div>
            </div>
            <Switch checked={preBackup} onCheckedChange={setPreBackup} />
          </div>

          <div className="bg-amber-500/10 border border-amber-500/20 p-4 rounded-lg flex gap-3 text-amber-500/90 text-sm">
            <AlertTriangle className="w-5 h-5 shrink-0 mt-0.5" />
            <div>
              <p className="font-medium mb-1">High-Stakes Operation</p>
              <p>Devices will lose connectivity during the reboot phase of the upgrade. Proceed with caution on production networks.</p>
            </div>
          </div>
        </div>
        <DialogFooter className="pt-4">
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={handleStart} disabled={createMut.isPending || (routerIds.length === 0 && groupIds.length === 0)}>
            {createMut.isPending && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
            Confirm & Start Upgrades
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
