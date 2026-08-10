import { useState, useMemo } from "react";
import {
  useListBackups,
  useGetBackup,
  useDiffBackups,
  useRunBackups,
  useDeleteBackup,
  useGetBackupSettings,
  useUpdateBackupSettings,
  getListBackupsQueryKey,
  getGetBackupQueryKey,
  getDiffBackupsQueryKey,
  getGetBackupSettingsQueryKey,
  useListRouters
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/contexts/auth-context";
import { useConfirm } from "@/components/confirm-dialog";
import { useSelection } from "@/hooks/use-selection";
import { SelectionBar } from "@/components/selection-bar";
import { FilterSortBar } from "@/components/filter-sort-bar";
import { TargetSelector } from "@/components/fleet/target-selector";
import { DiffViewer } from "@/components/fleet/diff-viewer";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { Archive, Play, Settings2, Trash2, FileText, CheckCircle2, XCircle, ArrowRightLeft, Loader2, GitCompare } from "lucide-react";
import { formatDate } from "@/lib/utils";

export default function Backups() {
  const { user } = useAuth();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const confirm = useConfirm();

  const [routerIdFilter, setRouterIdFilter] = useState<string>("");
  const [kindFilter, setKindFilter] = useState<string>("");
  
  const { data: routers = [] } = useListRouters();
  
  const { data: backupPage, isLoading: isBackupsLoading } = useListBackups(
    { 
      routerId: routerIdFilter ? parseInt(routerIdFilter) : undefined,
      kind: kindFilter as any || undefined,
      limit: 100
    },
    { query: { queryKey: getListBackupsQueryKey({ routerId: routerIdFilter ? parseInt(routerIdFilter) : undefined, kind: kindFilter as any || undefined, limit: 100 }) } }
  );

  const backups = backupPage?.items || [];
  
  const runMut = useRunBackups();
  const deleteMut = useDeleteBackup();

  const selection = useSelection(backups.map((b: any) => b.id));

  // Run backup modal
  const [isRunOpen, setIsRunOpen] = useState(false);
  const [runRouterIds, setRunRouterIds] = useState<number[]>([]);
  const [runGroupIds, setRunGroupIds] = useState<number[]>([]);

  // Settings modal
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  
  // View modal
  const [viewId, setViewId] = useState<number | null>(null);
  const { data: viewBackup, isLoading: isViewLoading } = useGetBackup(viewId || 0, {
    query: { enabled: !!viewId, queryKey: getGetBackupQueryKey(viewId || 0) }
  });

  // Diff modal
  const [isDiffOpen, setIsDiffOpen] = useState(false);
  const diffIds = Array.from(selection.selected);
  const { data: diffData, isLoading: isDiffLoading } = useDiffBackups(
    { fromId: diffIds[1] || 0, toId: diffIds[0] || 0 }, // newest first visually, but diff logic: from older (1) to newer (0)
    { query: { enabled: isDiffOpen && diffIds.length === 2, queryKey: getDiffBackupsQueryKey({ fromId: diffIds[1] || 0, toId: diffIds[0] || 0 }) } }
  );

  const handleRun = async () => {
    if (runRouterIds.length === 0 && runGroupIds.length === 0) {
      toast({ title: "Select targets", description: "Choose at least one device or group.", variant: "destructive" });
      return;
    }
    try {
      const res = await runMut.mutateAsync({ data: { routerIds: runRouterIds, groupIds: runGroupIds } });
      toast({ title: "Backup Started", description: res.message });
      setIsRunOpen(false);
      // refetch aggressively for a bit while they run
      setTimeout(() => queryClient.invalidateQueries({ queryKey: ["/api/backups"] }), 2000);
      setTimeout(() => queryClient.invalidateQueries({ queryKey: ["/api/backups"] }), 5000);
    } catch (err: any) {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    }
  };

  const handleDelete = async (id: number) => {
    if (!await confirm({ title: "Delete Backup", description: "Are you sure? This cannot be undone.", variant: "destructive" })) return;
    try {
      await deleteMut.mutateAsync({ id });
      toast({ title: "Backup deleted" });
      queryClient.invalidateQueries({ queryKey: ["/api/backups"] });
    } catch (err: any) {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    }
  };

  const handleOpenDiff = () => {
    if (diffIds.length !== 2) return;
    // ensure chronological order for sensible diff (older -> newer)
    const b1 = backups.find((b: any) => b.id === diffIds[0]);
    const b2 = backups.find((b: any) => b.id === diffIds[1]);
    if (!b1 || !b2) return;
    
    // Sort by ID assuming higher ID = newer
    diffIds.sort((a, b) => Number(a) - Number(b));
    
    setIsDiffOpen(true);
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight flex items-center gap-3">
            <Archive className="w-7 h-7 text-primary" />
            Config Backups
          </h1>
          <p className="text-muted-foreground mt-1">Archive of device configuration exports and historical changes.</p>
        </div>
        <div className="flex gap-2">
          {user?.role === "admin" && (
            <Button variant="outline" onClick={() => setIsSettingsOpen(true)} className="gap-2">
              <Settings2 className="w-4 h-4" /> Settings
            </Button>
          )}
          <Button onClick={() => { setRunRouterIds([]); setRunGroupIds([]); setIsRunOpen(true); }} className="gap-2">
            <Play className="w-4 h-4" /> Run Backup
          </Button>
        </div>
      </div>

      <div className="flex items-center gap-2">
        <FilterSortBar
          searchValue=""
          onSearchChange={() => {}}
          searchPlaceholder="Search backups..."
          filters={[
            {
              key: "routerId",
              label: "Device",
              type: "select",
              options: routers.map((r: any) => ({ label: r.name, value: String(r.id) }))
            },
            {
              key: "kind",
              label: "Kind",
              type: "select",
              options: [
                { label: "Manual", value: "manual" },
                { label: "Scheduled", value: "scheduled" },
                { label: "Pre Upgrade", value: "pre_upgrade" }
              ]
            }
          ]}
          activeFilters={{ routerId: routerIdFilter, kind: kindFilter }}
          onFilterChange={(k, v) => {
            if (k === "routerId") setRouterIdFilter(v as string);
            if (k === "kind") setKindFilter(v as string);
          }}
        />
      </div>

      {selection.count === 2 && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 bg-primary text-primary-foreground px-6 py-3 rounded-full shadow-2xl flex items-center gap-4 animate-in slide-in-from-bottom-4 z-50">
          <div className="flex items-center gap-2 font-medium">
            <GitCompare className="w-4 h-4" />
            <span>2 backups selected</span>
          </div>
          <Button size="sm" variant="secondary" onClick={handleOpenDiff} className="rounded-full">
            Compare Selected
          </Button>
          <Button size="sm" variant="ghost" onClick={selection.clear} className="rounded-full hover:bg-black/20">
            Clear
          </Button>
        </div>
      )}

      <Card className="glass-panel">
        <CardContent className="p-0">
          {isBackupsLoading ? (
            <div className="p-6 space-y-4">
              {Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-10 w-full" />)}
            </div>
          ) : backups.length === 0 ? (
            <div className="p-12 text-center">
              <Archive className="w-12 h-12 text-muted-foreground/30 mx-auto mb-3" />
              <p className="text-muted-foreground">No backups found.</p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-xs uppercase text-muted-foreground bg-black/40 border-b border-border/50">
                  <tr>
                    <th className="px-4 py-3 w-10"></th>
                    <th className="px-4 py-3 text-left">Status</th>
                    <th className="px-4 py-3 text-left">Device</th>
                    <th className="px-4 py-3 text-left">Kind</th>
                    <th className="px-4 py-3 text-left">Size</th>
                    <th className="px-4 py-3 text-left">Timestamp</th>
                    <th className="px-4 py-3 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border/50">
                  {backups.map((b: any) => (
                    <tr key={b.id} className={`hover:bg-white/[0.02] ${selection.selected.has(b.id) ? 'bg-primary/10' : ''}`}>
                      <td className="px-4 py-3">
                        <Checkbox 
                          checked={selection.selected.has(b.id)}
                          onCheckedChange={() => selection.toggle(b.id)}
                        />
                      </td>
                      <td className="px-4 py-3">
                        {b.status === "success" ? (
                          <div className="flex items-center gap-1.5 text-emerald-400">
                            <CheckCircle2 className="w-4 h-4" />
                            <span className="text-xs font-medium">Success</span>
                          </div>
                        ) : (
                          <div className="flex items-center gap-1.5 text-destructive">
                            <XCircle className="w-4 h-4" />
                            <span className="text-xs font-medium">Failed</span>
                          </div>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        <div className="font-medium text-foreground">{b.routerName}</div>
                        <div className="text-[10px] text-muted-foreground font-mono">{b.routerIp}</div>
                      </td>
                      <td className="px-4 py-3">
                        <Badge variant="outline" className="capitalize text-[10px]">
                          {b.kind.replace('_', ' ')}
                        </Badge>
                      </td>
                      <td className="px-4 py-3 text-muted-foreground font-mono text-xs">
                        {b.sizeBytes > 0 ? `${(b.sizeBytes / 1024).toFixed(1)} KB` : '—'}
                      </td>
                      <td className="px-4 py-3 text-muted-foreground text-xs whitespace-nowrap">
                        {formatDate(b.createdAt)}
                      </td>
                      <td className="px-4 py-3 text-right">
                        <div className="flex justify-end gap-1">
                          <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => setViewId(b.id)} disabled={b.status !== "success"}>
                            <FileText className="w-4 h-4" />
                          </Button>
                          {user?.role === "admin" && (
                            <Button variant="ghost" size="icon" className="h-7 w-7 text-destructive hover:bg-destructive/10" onClick={() => handleDelete(b.id)}>
                              <Trash2 className="w-4 h-4" />
                            </Button>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* View Modal */}
      <Dialog open={!!viewId} onOpenChange={(o) => !o && setViewId(null)}>
        <DialogContent className="max-w-4xl max-h-[85vh] flex flex-col">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <FileText className="w-5 h-5 text-primary" />
              Backup Content
            </DialogTitle>
            <DialogDescription>
              {viewBackup ? `${viewBackup.routerName} • ${formatDate(viewBackup.createdAt)}` : "Loading..."}
            </DialogDescription>
          </DialogHeader>
          <div className="flex-1 overflow-hidden flex flex-col min-h-[400px]">
            {isViewLoading ? (
              <div className="flex-1 flex items-center justify-center">
                <Loader2 className="w-8 h-8 text-primary animate-spin" />
              </div>
            ) : viewBackup ? (
              <div className="flex-1 overflow-y-auto border border-white/10 rounded-md bg-black/60">
                <pre className="p-4 text-xs font-mono text-muted-foreground whitespace-pre-wrap word-break-all">
                  {viewBackup.content || "Empty content."}
                </pre>
              </div>
            ) : (
              <div className="p-4 text-destructive">Failed to load backup.</div>
            )}
          </div>
        </DialogContent>
      </Dialog>

      {/* Diff Modal */}
      <Dialog open={isDiffOpen} onOpenChange={setIsDiffOpen}>
        <DialogContent className="max-w-5xl max-h-[90vh] flex flex-col">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <GitCompare className="w-5 h-5 text-primary" />
              Compare Backups
            </DialogTitle>
            <DialogDescription>
              Comparing older backup #{diffIds[0]} with newer backup #{diffIds[1]}.
            </DialogDescription>
          </DialogHeader>
          <div className="flex-1 overflow-hidden flex flex-col min-h-[500px]">
            {isDiffLoading ? (
              <div className="flex-1 flex items-center justify-center">
                <Loader2 className="w-8 h-8 text-primary animate-spin" />
              </div>
            ) : diffData ? (
              <div className="flex flex-col h-full space-y-4">
                <div className="flex gap-6 text-sm bg-card p-3 rounded-lg border border-white/5">
                  <div className="flex items-center gap-2">
                    <div className="w-3 h-3 rounded-full bg-emerald-500/20 border border-emerald-500/50"></div>
                    <span className="text-emerald-400 font-mono">+{diffData.addedLines} additions</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <div className="w-3 h-3 rounded-full bg-destructive/20 border border-destructive/50"></div>
                    <span className="text-destructive font-mono">-{diffData.removedLines} removals</span>
                  </div>
                  {diffData.identical && (
                    <Badge variant="outline" className="ml-auto border-emerald-500/30 text-emerald-400 bg-emerald-500/10">
                      Configs are identical
                    </Badge>
                  )}
                </div>
                <div className="flex-1 min-h-0 relative">
                  <DiffViewer diff={diffData.diff} className="absolute inset-0" />
                </div>
              </div>
            ) : (
              <div className="p-4 text-destructive">Failed to compute diff.</div>
            )}
          </div>
        </DialogContent>
      </Dialog>

      {/* Run Backup Modal */}
      <Dialog open={isRunOpen} onOpenChange={setIsRunOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Run On-Demand Backup</DialogTitle>
            <DialogDescription>
              Immediately fetch config exports from the selected devices.
            </DialogDescription>
          </DialogHeader>
          <div className="py-4">
            <TargetSelector 
              selectedRouterIds={runRouterIds}
              selectedGroupIds={runGroupIds}
              onChange={(r, g) => { setRunRouterIds(r); setRunGroupIds(g); }}
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setIsRunOpen(false)}>Cancel</Button>
            <Button onClick={handleRun} disabled={runMut.isPending || (runRouterIds.length === 0 && runGroupIds.length === 0)}>
              {runMut.isPending && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
              Start Backup
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Settings Modal */}
      <SettingsModal open={isSettingsOpen} onOpenChange={setIsSettingsOpen} />
    </div>
  );
}

function SettingsModal({ open, onOpenChange }: { open: boolean, onOpenChange: (open: boolean) => void }) {
  const { data: settings, isLoading } = useGetBackupSettings({
    query: { enabled: open, queryKey: getGetBackupSettingsQueryKey() }
  });
  const updateMut = useUpdateBackupSettings();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  
  const [enabled, setEnabled] = useState(false);
  const [timeOfDay, setTimeOfDay] = useState("02:00");
  const [retention, setRetention] = useState(30);

  // Sync state when settings load
  useMemo(() => {
    if (settings) {
      setEnabled(settings.enabled);
      setTimeOfDay(settings.timeOfDay || "02:00");
      setRetention(settings.retentionPerRouter || 30);
    }
  }, [settings]);

  const handleSave = async () => {
    try {
      await updateMut.mutateAsync({ data: { enabled, timeOfDay, retentionPerRouter: retention } });
      toast({ title: "Settings saved" });
      queryClient.invalidateQueries({ queryKey: getGetBackupSettingsQueryKey() });
      onOpenChange(false);
    } catch (err: any) {
      toast({ title: "Save failed", description: err.message, variant: "destructive" });
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Backup Settings</DialogTitle>
          <DialogDescription>Configure the automated daily fleet backups.</DialogDescription>
        </DialogHeader>
        {isLoading ? (
          <div className="p-8 flex justify-center"><Loader2 className="w-6 h-6 animate-spin text-primary" /></div>
        ) : (
          <div className="space-y-6 py-4">
            <div className="flex items-center justify-between p-4 bg-card/50 rounded-lg border border-white/5">
              <div className="space-y-0.5">
                <Label className="text-base">Enable Daily Backups</Label>
                <div className="text-sm text-muted-foreground">Automatically backup all devices every day.</div>
              </div>
              <Switch checked={enabled} onCheckedChange={setEnabled} />
            </div>

            <div className="space-y-2">
              <Label>Time of Day (HH:MM)</Label>
              <Input 
                type="time" 
                value={timeOfDay} 
                onChange={(e) => setTimeOfDay(e.target.value)} 
                disabled={!enabled}
                className="w-full sm:w-[200px]"
              />
            </div>

            <div className="space-y-2">
              <Label>Retention (Versions per device)</Label>
              <Input 
                type="number" 
                min={1} 
                max={365} 
                value={retention} 
                onChange={(e) => setRetention(parseInt(e.target.value) || 30)} 
                disabled={!enabled}
                className="w-full sm:w-[200px]"
              />
              <div className="text-xs text-muted-foreground mt-1">
                Identical configs are deduplicated automatically. This limits the number of distinct versions kept.
              </div>
            </div>
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={handleSave} disabled={updateMut.isPending}>
            {updateMut.isPending && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
            Save Settings
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
