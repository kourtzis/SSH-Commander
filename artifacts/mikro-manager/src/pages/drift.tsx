import { useState, useMemo } from "react";
import {
  useListGoldenConfigs,
  useCreateGoldenConfig,
  useUpdateGoldenConfig,
  useDeleteGoldenConfig,
  useCheckGoldenConfig,
  useGetGoldenConfigResults,
  getListGoldenConfigsQueryKey,
  getGetGoldenConfigResultsQueryKey,
  useListGroups
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { useConfirm } from "@/components/confirm-dialog";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { ShieldCheck, Plus, CheckCircle2, AlertTriangle, Play, Settings2, Trash2, Search, Edit2, Loader2, GitCompare, RefreshCcw } from "lucide-react";
import { DiffViewer } from "@/components/fleet/diff-viewer";
import { formatDate } from "@/lib/utils";

export default function Drift() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const confirm = useConfirm();

  const { data: configs = [], isLoading: isConfigsLoading } = useListGoldenConfigs();
  
  const [selectedId, setSelectedId] = useState<number | null>(null);
  
  // Create / Edit modal
  const [isEditorOpen, setIsEditorOpen] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);

  const selectedConfig = useMemo(() => configs.find((c: any) => c.id === selectedId), [configs, selectedId]);

  // Results for selected
  const { data: results = [], isLoading: isResultsLoading } = useGetGoldenConfigResults(selectedId || 0, {
    query: { enabled: !!selectedId, queryKey: getGetGoldenConfigResultsQueryKey(selectedId || 0) }
  });

  const checkMut = useCheckGoldenConfig();
  const deleteMut = useDeleteGoldenConfig();

  const handleCheck = async (id: number) => {
    try {
      const res = await checkMut.mutateAsync({ id });
      toast({ title: "Check complete", description: `Checked ${res.checked} devices. ${res.drifted} drifted, ${res.skipped} skipped.` });
      queryClient.invalidateQueries({ queryKey: getListGoldenConfigsQueryKey() });
      queryClient.invalidateQueries({ queryKey: getGetGoldenConfigResultsQueryKey(id) });
    } catch (err: any) {
      toast({ title: "Check failed", description: err.message, variant: "destructive" });
    }
  };

  const handleDelete = async (id: number, e: React.MouseEvent) => {
    e.stopPropagation();
    if (!await confirm({ title: "Delete Golden Config", description: "Are you sure? Compliance tracking for this group will stop.", variant: "destructive" })) return;
    try {
      await deleteMut.mutateAsync({ id });
      toast({ title: "Deleted" });
      if (selectedId === id) setSelectedId(null);
      queryClient.invalidateQueries({ queryKey: getListGoldenConfigsQueryKey() });
    } catch (err: any) {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    }
  };

  const openCreate = () => {
    setEditingId(null);
    setIsEditorOpen(true);
  };

  const openEdit = (id: number, e: React.MouseEvent) => {
    e.stopPropagation();
    setEditingId(id);
    setIsEditorOpen(true);
  };

  // View Diff modal
  const [diffResult, setDiffResult] = useState<any | null>(null);

  return (
    <div className="flex flex-col h-[calc(100vh-6rem)] -m-2 sm:-m-4 md:-m-6 lg:-m-8">
      {/* Header */}
      <div className="px-6 py-5 border-b border-border/50 bg-background/50 backdrop-blur-sm z-10 flex-none flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight flex items-center gap-3">
            <ShieldCheck className="w-6 h-6 text-primary" />
            Golden Config Drift
          </h1>
          <p className="text-muted-foreground text-sm mt-1">Monitor compliance against baseline configurations per group.</p>
        </div>
        <Button onClick={openCreate} className="gap-2">
          <Plus className="w-4 h-4" /> New Golden Config
        </Button>
      </div>

      {/* Main split */}
      <div className="flex flex-1 min-h-0">
        
        {/* Left List */}
        <div className="w-1/3 border-r border-border/50 flex flex-col bg-card/10">
          <div className="p-4 border-b border-border/50">
            <div className="relative">
              <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
              <Input placeholder="Search baselines..." className="pl-9 bg-background" />
            </div>
          </div>
          <div className="flex-1 overflow-y-auto">
            {isConfigsLoading ? (
              <div className="p-4 flex justify-center"><Loader2 className="w-6 h-6 animate-spin text-muted-foreground" /></div>
            ) : configs.length === 0 ? (
              <div className="p-8 text-center text-muted-foreground text-sm">
                No golden configs. Create one to track drift.
              </div>
            ) : (
              <div className="p-2 space-y-1">
                {configs.map((c: any) => {
                  const isSelected = selectedId === c.id;
                  const isDrifted = c.driftedCount > 0;
                  return (
                    <button
                      key={c.id}
                      onClick={() => setSelectedId(c.id)}
                      className={`w-full text-left p-3 rounded-lg border transition-all ${
                        isSelected 
                          ? "bg-primary/10 border-primary/30" 
                          : "bg-transparent border-transparent hover:bg-white/5 hover:border-white/10"
                      }`}
                    >
                      <div className="flex justify-between items-start mb-1">
                        <span className="font-medium truncate pr-2">{c.name}</span>
                        <div className="flex items-center gap-1 shrink-0">
                          <Button variant="ghost" size="icon" className="w-6 h-6 h-6 w-6 rounded-md hover:bg-white/10" onClick={(e) => openEdit(c.id, e)}>
                            <Edit2 className="w-3 h-3 text-muted-foreground" />
                          </Button>
                          <Button variant="ghost" size="icon" className="w-6 h-6 rounded-md hover:bg-destructive/10" onClick={(e) => handleDelete(c.id, e)}>
                            <Trash2 className="w-3 h-3 text-destructive" />
                          </Button>
                        </div>
                      </div>
                      <div className="text-xs text-muted-foreground mb-3 flex items-center gap-1.5">
                        <span className="px-1.5 py-0.5 rounded bg-black/40 border border-white/5">{c.groupName}</span>
                      </div>
                      <div className="flex items-center justify-between text-xs">
                        <div className="flex items-center gap-3">
                          <span className="text-muted-foreground">{c.routerCount} devices</span>
                          {c.routerCount > 0 && (
                            isDrifted ? (
                              <span className="text-destructive flex items-center gap-1">
                                <AlertTriangle className="w-3 h-3" /> {c.driftedCount} drifted
                              </span>
                            ) : (
                              <span className="text-emerald-400 flex items-center gap-1">
                                <CheckCircle2 className="w-3 h-3" /> In sync
                              </span>
                            )
                          )}
                        </div>
                      </div>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        </div>

        {/* Right Detail */}
        <div className="w-2/3 flex flex-col bg-background relative">
          {selectedConfig ? (
            <>
              <div className="p-6 flex-none border-b border-border/50 bg-card/20">
                <div className="flex justify-between items-start">
                  <div>
                    <h2 className="text-xl font-bold">{selectedConfig.name}</h2>
                    <p className="text-sm text-muted-foreground mt-1">
                      Tracking group <span className="font-mono text-primary/80">{selectedConfig.groupName}</span> 
                      • Last checked: {selectedConfig.lastCheckedAt ? formatDate(selectedConfig.lastCheckedAt) : 'Never'}
                    </p>
                  </div>
                  <Button 
                    onClick={() => handleCheck(selectedConfig.id)} 
                    disabled={checkMut.isPending}
                    className="gap-2"
                  >
                    {checkMut.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCcw className="w-4 h-4" />}
                    Check Now
                  </Button>
                </div>
                
                {/* Stats row */}
                <div className="grid grid-cols-4 gap-4 mt-6">
                  <div className="bg-black/40 border border-white/5 p-3 rounded-lg flex flex-col">
                    <span className="text-xs text-muted-foreground mb-1 uppercase tracking-wider">Devices</span>
                    <span className="text-2xl font-light">{selectedConfig.routerCount}</span>
                  </div>
                  <div className="bg-black/40 border border-white/5 p-3 rounded-lg flex flex-col">
                    <span className="text-xs text-muted-foreground mb-1 uppercase tracking-wider">In Sync</span>
                    <span className="text-2xl font-light text-emerald-400">{selectedConfig.routerCount - selectedConfig.driftedCount}</span>
                  </div>
                  <div className="bg-black/40 border border-white/5 p-3 rounded-lg flex flex-col">
                    <span className="text-xs text-muted-foreground mb-1 uppercase tracking-wider">Drifted</span>
                    <span className={`text-2xl font-light ${selectedConfig.driftedCount > 0 ? 'text-destructive' : 'text-muted-foreground'}`}>{selectedConfig.driftedCount}</span>
                  </div>
                  <div className="bg-black/40 border border-white/5 p-3 rounded-lg flex flex-col">
                    <span className="text-xs text-muted-foreground mb-1 uppercase tracking-wider">Ignores</span>
                    <span className="text-2xl font-light">{selectedConfig.ignorePatterns.length} rules</span>
                  </div>
                </div>
              </div>

              <div className="flex-1 overflow-y-auto">
                {isResultsLoading ? (
                  <div className="p-12 flex justify-center"><Loader2 className="w-8 h-8 animate-spin text-primary" /></div>
                ) : results.length === 0 ? (
                  <div className="p-12 text-center text-muted-foreground">
                    <ShieldCheck className="w-12 h-12 text-muted-foreground/30 mx-auto mb-4" />
                    <p>No results yet.</p>
                    <p className="text-sm mt-1">Click "Check Now" to evaluate devices against the baseline.</p>
                  </div>
                ) : (
                  <div className="p-6">
                    <div className="border border-border/50 rounded-lg overflow-hidden bg-card/20">
                      <table className="w-full text-sm">
                        <thead className="text-xs uppercase text-muted-foreground bg-black/40 border-b border-border/50">
                          <tr>
                            <th className="px-4 py-3 text-left">Device</th>
                            <th className="px-4 py-3 text-left">Status</th>
                            <th className="px-4 py-3 text-left">Diff</th>
                            <th className="px-4 py-3 text-left">Last Checked</th>
                            <th className="px-4 py-3 text-right">Actions</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-border/50">
                          {results.map((r: any) => (
                            <tr key={r.id} className="hover:bg-white/[0.02]">
                              <td className="px-4 py-3">
                                <div className="font-medium">{r.routerName}</div>
                                <div className="text-[10px] font-mono text-muted-foreground">{r.routerIp}</div>
                              </td>
                              <td className="px-4 py-3">
                                {r.inSync ? (
                                  <Badge variant="outline" className="text-emerald-400 border-emerald-500/30 bg-emerald-500/10">In Sync</Badge>
                                ) : (
                                  <Badge variant="outline" className="text-destructive border-destructive/30 bg-destructive/10">Drifted</Badge>
                                )}
                              </td>
                              <td className="px-4 py-3 font-mono text-xs">
                                {!r.inSync && (
                                  <div className="flex gap-2">
                                    <span className="text-emerald-400">+{r.addedLines}</span>
                                    <span className="text-destructive">-{r.removedLines}</span>
                                  </div>
                                )}
                              </td>
                              <td className="px-4 py-3 text-muted-foreground text-xs">
                                {formatDate(r.checkedAt)}
                              </td>
                              <td className="px-4 py-3 text-right">
                                {!r.inSync && r.diff && (
                                  <Button variant="ghost" size="sm" className="gap-2 text-xs h-8" onClick={() => setDiffResult(r)}>
                                    <GitCompare className="w-3.5 h-3.5" /> View Diff
                                  </Button>
                                )}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}
              </div>
            </>
          ) : (
            <div className="flex-1 flex flex-col items-center justify-center text-muted-foreground p-8 text-center">
              <ShieldCheck className="w-16 h-16 text-muted-foreground/20 mb-4" />
              <p className="text-lg font-medium text-foreground mb-1">Select a Golden Config</p>
              <p className="max-w-sm">Choose a baseline from the left to view compliance results, or create a new one.</p>
            </div>
          )}
        </div>
      </div>

      <ConfigEditorModal 
        open={isEditorOpen} 
        onOpenChange={setIsEditorOpen} 
        editingId={editingId} 
        configs={configs}
      />

      <Dialog open={!!diffResult} onOpenChange={(o) => !o && setDiffResult(null)}>
        <DialogContent className="max-w-5xl max-h-[90vh] flex flex-col">
          <DialogHeader>
            <DialogTitle>Drift Diff: {diffResult?.routerName}</DialogTitle>
            <DialogDescription>
              Comparing device configuration against the golden baseline.
            </DialogDescription>
          </DialogHeader>
          <div className="flex-1 overflow-hidden flex flex-col min-h-[500px]">
            {diffResult?.diff && <DiffViewer diff={diffResult.diff} className="flex-1 absolute inset-0" />}
            {/* The DiffViewer parent needs relative, let's wrap it */}
            <div className="flex-1 relative mt-4">
               {diffResult?.diff && <DiffViewer diff={diffResult.diff} className="absolute inset-0" />}
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function ConfigEditorModal({ open, onOpenChange, editingId, configs }: { open: boolean, onOpenChange: (o: boolean) => void, editingId: number | null, configs: any[] }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { data: groups = [] } = useListGroups();
  
  const createMut = useCreateGoldenConfig();
  const updateMut = useUpdateGoldenConfig();

  const [groupId, setGroupId] = useState("");
  const [name, setName] = useState("");
  const [content, setContent] = useState("");
  const [ignores, setIgnores] = useState("");

  useMemo(() => {
    if (open) {
      if (editingId) {
        const c = configs.find((x: any) => x.id === editingId);
        if (c) {
          setGroupId(String(c.groupId));
          setName(c.name);
          setContent(c.content);
          setIgnores(c.ignorePatterns.join("\n"));
        }
      } else {
        setGroupId("");
        setName("");
        setContent("");
        setIgnores("");
      }
    }
  }, [open, editingId, configs]);

  const handleSave = async () => {
    if (!groupId || !name.trim() || !content.trim()) {
      toast({ title: "Validation Error", description: "Group, name, and baseline content are required.", variant: "destructive" });
      return;
    }

    const payload = {
      groupId: parseInt(groupId),
      name: name.trim(),
      content: content.trim(),
      ignorePatterns: ignores.split("\n").map((s: string) => s.trim()).filter(Boolean)
    };

    try {
      if (editingId) {
        await updateMut.mutateAsync({ id: editingId, data: payload });
        toast({ title: "Golden config updated" });
      } else {
        await createMut.mutateAsync({ data: payload });
        toast({ title: "Golden config created" });
      }
      queryClient.invalidateQueries({ queryKey: getListGoldenConfigsQueryKey() });
      onOpenChange(false);
    } catch (err: any) {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl max-h-[90vh] flex flex-col">
        <DialogHeader>
          <DialogTitle>{editingId ? "Edit Golden Config" : "New Golden Config"}</DialogTitle>
          <DialogDescription>Define the baseline configuration for a group of routers.</DialogDescription>
        </DialogHeader>
        <div className="flex-1 overflow-y-auto space-y-4 py-4 min-h-0 flex flex-col">
          <div className="grid grid-cols-2 gap-4 flex-none">
            <div className="space-y-2">
              <Label>Target Group</Label>
              <select
                className="w-full bg-background border border-white/10 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-primary/50"
                value={groupId}
                onChange={(e) => setGroupId(e.target.value)}
                disabled={!!editingId}
              >
                <option value="">— select group —</option>
                {groups.map((g: any) => <option key={g.id} value={g.id}>{g.name}</option>)}
              </select>
            </div>
            <div className="space-y-2">
              <Label>Name</Label>
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Edge Routers Baseline" />
            </div>
          </div>

          <div className="flex-1 min-h-[300px] flex flex-col space-y-2">
            <div className="flex justify-between items-end">
              <Label>Baseline Configuration Content</Label>
            </div>
            <Textarea 
              value={content} 
              onChange={(e) => setContent(e.target.value)} 
              placeholder="Paste the desired export output here..."
              className="flex-1 font-mono text-xs resize-none"
            />
          </div>

          <div className="flex-none space-y-2">
            <Label>Ignore Patterns (Regex, one per line)</Label>
            <Textarea 
              value={ignores} 
              onChange={(e) => setIgnores(e.target.value)} 
              placeholder="^#.*&#10;uptime:.*"
              className="h-24 font-mono text-xs resize-none"
            />
            <p className="text-xs text-muted-foreground">Matching lines will be removed from both configs before comparison (e.g. clocks, volatile comments).</p>
          </div>
        </div>
        <DialogFooter className="flex-none pt-4">
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={handleSave} disabled={createMut.isPending || updateMut.isPending}>
            {(createMut.isPending || updateMut.isPending) && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
            Save Baseline
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
