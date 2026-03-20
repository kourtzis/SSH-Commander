import { useState, useRef, useCallback } from "react";
import { useListSnippets } from "@workspace/api-client-react";
import { useSnippetsMutations } from "@/hooks/use-mutations";
import { useSelection } from "@/hooks/use-selection";
import { SelectionBar } from "@/components/selection-bar";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Plus, Code2, Trash2, Edit2, Search, GripVertical, X, FileCode } from "lucide-react";
import { SnippetViewer } from "@/components/snippet-viewer";
import { useToast } from "@/hooks/use-toast";
import { extractTags } from "@/lib/utils";

interface ComposerEntry {
  id: number;
  instanceId: string;
  name: string;
  category: string;
  code: string;
}

function useDragReorder<T>(items: T[], setItems: (items: T[]) => void) {
  const dragIdx = useRef<number | null>(null);
  const overIdx = useRef<number | null>(null);

  const onDragStart = useCallback((idx: number) => {
    dragIdx.current = idx;
  }, []);

  const onDragOver = useCallback((e: React.DragEvent, idx: number) => {
    e.preventDefault();
    overIdx.current = idx;
  }, []);

  const onDrop = useCallback(() => {
    if (dragIdx.current === null || overIdx.current === null || dragIdx.current === overIdx.current) return;
    const next = [...items];
    const [moved] = next.splice(dragIdx.current, 1);
    next.splice(overIdx.current, 0, moved);
    setItems(next);
    dragIdx.current = null;
    overIdx.current = null;
  }, [items, setItems]);

  return { onDragStart, onDragOver, onDrop };
}

export default function Snippets() {
  const { data: snippets = [], isLoading } = useListSnippets();
  const { createSnippet, updateSnippet, deleteSnippet } = useSnippetsMutations();
  const { toast } = useToast();

  const [search, setSearch] = useState("");
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [editingSnippet, setEditingSnippet] = useState<any>(null);
  const [isBulkDeleting, setIsBulkDeleting] = useState(false);

  const [name, setName] = useState("");
  const [category, setCategory] = useState("");
  const [description, setDescription] = useState("");
  const [code, setCode] = useState("");
  const [composerSnippets, setComposerSnippets] = useState<ComposerEntry[]>([]);

  const composerDrag = useDragReorder(composerSnippets, setComposerSnippets);

  const filteredSnippets = snippets.filter(s =>
    s.name.toLowerCase().includes(search.toLowerCase()) ||
    s.category.toLowerCase().includes(search.toLowerCase())
  );

  const selection = useSelection(filteredSnippets.map(s => s.id));

  const composedCode = composerSnippets.map(s => s.code).join("\n\n");
  const combinedCode = composedCode
    ? (code.trim() ? composedCode + "\n\n" + code.trim() : composedCode)
    : code;

  const handleOpenDialog = (snippet?: any) => {
    if (snippet) {
      setEditingSnippet(snippet);
      setName(snippet.name);
      setCategory(snippet.category);
      setDescription(snippet.description || "");
      setCode(snippet.code);
      setComposerSnippets([]);
    } else {
      setEditingSnippet(null);
      setName("");
      setCategory("");
      setDescription("");
      setCode("");
      setComposerSnippets([]);
    }
    setIsDialogOpen(true);
  };

  const handleSave = async () => {
    try {
      const data = { name, category, description, code: combinedCode };
      if (editingSnippet) {
        await updateSnippet.mutateAsync({ id: editingSnippet.id, data });
        toast({ title: "Snippet updated" });
      } else {
        await createSnippet.mutateAsync({ data });
        toast({ title: "Snippet created" });
      }
      setIsDialogOpen(false);
    } catch (err: any) {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    }
  };

  const handleDelete = async (id: number) => {
    if (confirm("Delete this snippet?")) {
      try {
        await deleteSnippet.mutateAsync({ id });
        toast({ title: "Snippet deleted" });
      } catch (err: any) {
        toast({ title: "Error", description: err.message, variant: "destructive" });
      }
    }
  };

  const handleBulkDelete = async () => {
    if (!confirm(`Delete ${selection.count} selected snippet(s)?`)) return;
    setIsBulkDeleting(true);
    try {
      await Promise.all(selection.ids.map(id => deleteSnippet.mutateAsync({ id })));
      toast({ title: `${selection.count} snippet(s) deleted` });
      selection.clear();
    } catch (err: any) {
      toast({ title: "Error deleting snippets", description: err.message, variant: "destructive" });
    } finally {
      setIsBulkDeleting(false);
    }
  };

  const handleAddComposerSnippet = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const id = parseInt(e.target.value);
    const snippet = snippets.find(s => s.id === id);
    if (!snippet) return;
    setComposerSnippets(prev => [
      ...prev,
      {
        id: snippet.id,
        instanceId: `${snippet.id}-${Date.now()}`,
        name: snippet.name,
        category: snippet.category,
        code: snippet.code,
      },
    ]);
    e.target.value = "";
  };

  const removeComposerSnippet = (instanceId: string) => {
    setComposerSnippets(prev => prev.filter(s => s.instanceId !== instanceId));
  };

  const currentTags = extractTags(combinedCode);

  const availableForComposer = editingSnippet
    ? snippets.filter(s => s.id !== editingSnippet.id)
    : snippets;

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Code Snippets</h1>
          <p className="text-muted-foreground mt-1">Reusable RouterOS scripts with parameter tags.</p>
        </div>
        <Button onClick={() => handleOpenDialog()}>
          <Plus className="w-4 h-4 mr-2" /> New Snippet
        </Button>
      </div>

      <div className="relative max-w-md">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
        <Input
          placeholder="Search snippets or categories..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="pl-9 bg-card border-border/50 shadow-sm"
        />
      </div>

      <SelectionBar count={selection.count} label="snippets" onDelete={handleBulkDelete} onClear={selection.clear} isDeleting={isBulkDeleting} />

      {isLoading ? (
        <div className="text-muted-foreground">Loading snippets...</div>
      ) : filteredSnippets.length === 0 ? (
        <Card className="glass-panel text-center p-12">
          <Code2 className="w-12 h-12 mx-auto text-muted-foreground/30 mb-4" />
          <h3 className="text-lg font-medium">No snippets found</h3>
          <p className="text-muted-foreground mt-1">Create your first script template.</p>
        </Card>
      ) : (
        <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
          {filteredSnippets.map((snippet) => (
            <Card key={snippet.id} className={`glass-panel flex flex-col ${selection.selected.has(snippet.id) ? "ring-1 ring-primary/50" : ""}`}>
              <CardHeader className="flex flex-row items-start justify-between pb-4">
                <div className="flex items-start gap-3">
                  <div className="pt-0.5">
                    <Checkbox
                      checked={selection.selected.has(snippet.id)}
                      onCheckedChange={() => selection.toggle(snippet.id)}
                      aria-label={`Select ${snippet.name}`}
                    />
                  </div>
                  <div>
                    <div className="flex items-center gap-2 mb-2">
                      <Badge variant="secondary" className="bg-primary/10 text-primary">{snippet.category}</Badge>
                      {extractTags(snippet.code).length > 0 && (
                        <Badge variant="outline" className="border-primary/30 text-primary/70">{extractTags(snippet.code).length} Tags</Badge>
                      )}
                    </div>
                    <CardTitle className="text-xl">{snippet.name}</CardTitle>
                    {snippet.description && <CardDescription className="mt-1">{snippet.description}</CardDescription>}
                  </div>
                </div>
                <div className="flex gap-2">
                  <Button variant="ghost" size="icon" onClick={() => handleOpenDialog(snippet)}>
                    <Edit2 className="w-4 h-4" />
                  </Button>
                  <Button variant="ghost" size="icon" className="text-destructive hover:text-destructive hover:bg-destructive/10" onClick={() => handleDelete(snippet.id)}>
                    <Trash2 className="w-4 h-4" />
                  </Button>
                </div>
              </CardHeader>
              <CardContent className="flex-1">
                <div className="max-h-48 overflow-y-auto rounded-xl">
                  <SnippetViewer code={snippet.code} />
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <Dialog open={isDialogOpen} onOpenChange={setIsDialogOpen}>
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{editingSnippet ? "Edit Snippet" : "New Snippet"}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>Name</Label>
                <Input value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Set Identity" />
              </div>
              <div className="space-y-2">
                <Label>Category</Label>
                <Input value={category} onChange={e => setCategory(e.target.value)} placeholder="e.g. Provisioning" />
              </div>
            </div>
            <div className="space-y-2">
              <Label>Description</Label>
              <Input value={description} onChange={e => setDescription(e.target.value)} placeholder="What does this do?" />
            </div>

            <div className="space-y-3">
              <div className="flex justify-between items-end">
                <Label>Compose from Existing Snippets (Optional)</Label>
              </div>
              {availableForComposer.length > 0 ? (
                <select
                  className="flex h-10 w-full rounded-xl border border-input bg-background/50 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
                  onChange={handleAddComposerSnippet}
                  value=""
                >
                  <option value="" disabled>Add a snippet to compose...</option>
                  {availableForComposer.map(s => (
                    <option key={s.id} value={s.id}>{s.name} ({s.category})</option>
                  ))}
                </select>
              ) : (
                <p className="text-xs text-muted-foreground italic p-2 border border-white/5 rounded-xl bg-black/20">No other snippets available yet. Create snippets first, then you can compose new ones from them.</p>
              )}

              {composerSnippets.length > 0 && (
                <div className="space-y-1 border border-white/5 rounded-xl bg-black/20 p-2">
                  <div className="px-2 py-1 flex justify-between items-center">
                    <span className="text-xs text-muted-foreground font-semibold uppercase">Composition Order (drag to reorder)</span>
                    <span className="text-xs text-muted-foreground">{composerSnippets.length} snippet{composerSnippets.length !== 1 ? "s" : ""}</span>
                  </div>
                  {composerSnippets.map((s, idx) => (
                    <div
                      key={s.instanceId}
                      draggable
                      onDragStart={() => composerDrag.onDragStart(idx)}
                      onDragOver={(e) => composerDrag.onDragOver(e, idx)}
                      onDrop={composerDrag.onDrop}
                      className="flex items-center gap-2 p-2.5 rounded-lg bg-black/30 border border-white/5 hover:border-primary/30 transition-colors group cursor-grab active:cursor-grabbing"
                    >
                      <GripVertical className="w-4 h-4 text-muted-foreground/50 group-hover:text-muted-foreground shrink-0" />
                      <span className="text-xs text-muted-foreground font-mono w-5 shrink-0">{idx + 1}.</span>
                      <FileCode className="w-4 h-4 text-primary shrink-0" />
                      <span className="text-sm font-medium flex-1 truncate">{s.name}</span>
                      <Badge variant="outline" className="text-xs border-white/10 shrink-0">{s.category}</Badge>
                      <button onClick={() => removeComposerSnippet(s.instanceId)} className="text-muted-foreground hover:text-destructive transition-colors shrink-0">
                        <X className="w-4 h-4" />
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="space-y-2">
              <div className="flex justify-between">
                <Label>{composerSnippets.length > 0 ? "Additional Custom Code (appended after composed snippets)" : "Script Code"}</Label>
                <span className="text-xs text-muted-foreground">Use {'{{VAR_NAME}}'} for variables</span>
              </div>
              <Textarea
                value={code}
                onChange={e => setCode(e.target.value)}
                className="h-48 font-mono text-sm"
                placeholder={composerSnippets.length > 0 ? "Optional: add custom commands after the composed snippets..." : "/system identity set name={{HOSTNAME}}"}
              />
              {currentTags.length > 0 && (
                <div className="flex flex-wrap gap-2 mt-2">
                  <span className="text-xs text-muted-foreground self-center">Detected Tags:</span>
                  {currentTags.map(tag => (
                    <span key={tag} className="tag-highlight">{`{{${tag}}}`}</span>
                  ))}
                </div>
              )}
            </div>

            {composerSnippets.length > 0 && combinedCode && (
              <div className="space-y-2">
                <Label className="text-muted-foreground">Combined Script Preview</Label>
                <pre className="text-xs font-mono text-emerald-400 bg-black/40 p-4 rounded-xl border border-white/5 overflow-x-auto whitespace-pre-wrap max-h-48 overflow-y-auto">{combinedCode}</pre>
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setIsDialogOpen(false)}>Cancel</Button>
            <Button onClick={handleSave} disabled={!name || !category || (!code && composerSnippets.length === 0)}>Save Snippet</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
