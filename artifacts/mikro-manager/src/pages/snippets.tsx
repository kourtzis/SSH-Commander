import { useState, useMemo } from "react";
import { useListSnippets } from "@workspace/api-client-react";
import { useSnippetsMutations } from "@/hooks/use-mutations";
import { useSelection } from "@/hooks/use-selection";
import { SelectionBar } from "@/components/selection-bar";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Plus, Code2, Trash2, Edit2 } from "lucide-react";
import { SnippetViewer } from "@/components/snippet-viewer";
import { ScriptBuilder, ScriptBlock, buildCombinedScript } from "@/components/script-builder";
import { TagInput } from "@/components/tag-input";
import { FilterSortBar, ActiveSort, applySort } from "@/components/filter-sort-bar";
import { useToast } from "@/hooks/use-toast";
import { extractTags } from "@/lib/utils";

export default function Snippets() {
  const { data: snippets = [], isLoading } = useListSnippets();
  const { createSnippet, updateSnippet, deleteSnippet } = useSnippetsMutations();
  const { toast } = useToast();

  const [search, setSearch] = useState("");
  const [filterTags, setFilterTags] = useState<string[]>([]);
  const [sort, setSort] = useState<ActiveSort>({ key: "name", dir: "asc" });
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [editingSnippet, setEditingSnippet] = useState<any>(null);
  const [isBulkDeleting, setIsBulkDeleting] = useState(false);

  const [name, setName] = useState("");
  const [formTags, setFormTags] = useState<string[]>([]);
  const [description, setDescription] = useState("");
  const [scriptBlocks, setScriptBlocks] = useState<ScriptBlock[]>([]);

  const allTags = useMemo(() => {
    const set = new Set<string>();
    snippets.forEach(s => (s.tags || []).forEach(t => set.add(t)));
    return Array.from(set).sort();
  }, [snippets]);

  const filtered = useMemo(() => {
    let result = snippets.filter(s => {
      const matchesSearch = !search ||
        s.name.toLowerCase().includes(search.toLowerCase()) ||
        (s.tags || []).some(t => t.toLowerCase().includes(search.toLowerCase()));
      const matchesTags = filterTags.length === 0 ||
        filterTags.every(ft => (s.tags || []).includes(ft));
      return matchesSearch && matchesTags;
    });

    result = applySort(result, sort, {
      name: (s) => s.name,
      date: (s) => new Date(s.updatedAt),
      tags: (s) => (s.tags || []).length,
    });

    return result;
  }, [snippets, search, filterTags, sort]);

  const selection = useSelection(filtered.map(s => s.id));

  const combinedCode = buildCombinedScript(scriptBlocks);

  const handleOpenDialog = (snippet?: any) => {
    if (snippet) {
      setEditingSnippet(snippet);
      setName(snippet.name);
      setFormTags(snippet.tags || []);
      setDescription(snippet.description || "");
      setScriptBlocks([{
        instanceId: `existing-${Date.now()}`,
        type: "code",
        code: snippet.code,
      }]);
    } else {
      setEditingSnippet(null);
      setName("");
      setFormTags([]);
      setDescription("");
      setScriptBlocks([]);
    }
    setIsDialogOpen(true);
  };

  const handleSave = async () => {
    try {
      const data = { name, tags: formTags, description, code: combinedCode };
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

  const currentTags = extractTags(combinedCode);

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Code Snippets</h1>
          <p className="text-muted-foreground mt-1">Reusable SSH scripts with parameter tags.</p>
        </div>
        <Button onClick={() => handleOpenDialog()}>
          <Plus className="w-4 h-4 mr-2" /> New Snippet
        </Button>
      </div>

      <FilterSortBar
        searchValue={search}
        onSearchChange={setSearch}
        searchPlaceholder="Search snippets by name or tag..."
        filters={allTags.length > 0 ? [
          { key: "tags", label: "Tags", type: "tags", allTags },
        ] : []}
        activeFilters={{ tags: filterTags }}
        onFilterChange={(key, value) => {
          if (key === "tags") setFilterTags(value as string[]);
        }}
        sortOptions={[
          { key: "name", label: "Name" },
          { key: "date", label: "Updated" },
          { key: "tags", label: "Tags" },
        ]}
        activeSort={sort}
        onSortChange={setSort}
      />

      <SelectionBar count={selection.count} label="snippets" onDelete={handleBulkDelete} onClear={selection.clear} isDeleting={isBulkDeleting} />

      {isLoading ? (
        <div className="text-muted-foreground">Loading snippets...</div>
      ) : filtered.length === 0 ? (
        <Card className="glass-panel text-center p-12">
          <Code2 className="w-12 h-12 mx-auto text-muted-foreground/30 mb-4" />
          <h3 className="text-lg font-medium">No snippets found</h3>
          <p className="text-muted-foreground mt-1">
            {search || filterTags.length > 0 ? "Try adjusting your filters." : "Create your first script template."}
          </p>
        </Card>
      ) : (
        <div className="space-y-4">
          <div className="flex items-center gap-3 px-1">
            <Checkbox
              checked={selection.isAllSelected ? true : selection.isSomeSelected ? "indeterminate" : false}
              onCheckedChange={selection.toggleAll}
              aria-label="Select all snippets"
            />
            <span className="text-sm text-muted-foreground">
              {selection.isAllSelected ? "Deselect all" : "Select all"} ({filtered.length})
            </span>
          </div>
        <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
          {filtered.map((snippet) => (
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
                    <div className="flex items-center gap-1.5 mb-2 flex-wrap">
                      {(snippet.tags || []).map(tag => (
                        <Badge key={tag} variant="secondary" className="bg-primary/10 text-primary text-xs">{tag}</Badge>
                      ))}
                      {extractTags(snippet.code).length > 0 && (
                        <Badge variant="outline" className="border-primary/30 text-primary/70">{extractTags(snippet.code).length} Vars</Badge>
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
        </div>
      )}

      <Dialog open={isDialogOpen} onOpenChange={setIsDialogOpen}>
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{editingSnippet ? "Edit Snippet" : "New Snippet"}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label>Name</Label>
              <Input value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Set Identity" />
            </div>
            <div className="space-y-2">
              <Label>Tags</Label>
              <TagInput tags={formTags} onChange={setFormTags} allTags={allTags} placeholder="e.g. provisioning, firewall..." />
            </div>
            <div className="space-y-2">
              <Label>Description</Label>
              <Input value={description} onChange={e => setDescription(e.target.value)} placeholder="What does this do?" />
            </div>

            <ScriptBuilder
              blocks={scriptBlocks}
              onChange={setScriptBlocks}
              snippets={snippets}
              excludeSnippetId={editingSnippet?.id}
            />

            {currentTags.length > 0 && (
              <div className="flex flex-wrap gap-2">
                <span className="text-xs text-muted-foreground self-center">Detected Variables:</span>
                {currentTags.map(tag => (
                  <span key={tag} className="tag-highlight">{`{{${tag}}}`}</span>
                ))}
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setIsDialogOpen(false)}>Cancel</Button>
            <Button onClick={handleSave} disabled={!name || !combinedCode}>Save Snippet</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
