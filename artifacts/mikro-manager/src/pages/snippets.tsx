import { useState } from "react";
import { useListSnippets } from "@workspace/api-client-react";
import { useSnippetsMutations } from "@/hooks/use-mutations";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Plus, Code2, Trash2, Edit2, Search } from "lucide-react";
import { SnippetViewer } from "@/components/snippet-viewer";
import { useToast } from "@/hooks/use-toast";
import { extractTags } from "@/lib/utils";

export default function Snippets() {
  const { data: snippets = [], isLoading } = useListSnippets();
  const { createSnippet, updateSnippet, deleteSnippet } = useSnippetsMutations();
  const { toast } = useToast();

  const [search, setSearch] = useState("");
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [editingSnippet, setEditingSnippet] = useState<any>(null);

  const [name, setName] = useState("");
  const [category, setCategory] = useState("");
  const [description, setDescription] = useState("");
  const [code, setCode] = useState("");

  const filteredSnippets = snippets.filter(s => 
    s.name.toLowerCase().includes(search.toLowerCase()) || 
    s.category.toLowerCase().includes(search.toLowerCase())
  );

  const handleOpenDialog = (snippet?: any) => {
    if (snippet) {
      setEditingSnippet(snippet);
      setName(snippet.name);
      setCategory(snippet.category);
      setDescription(snippet.description || "");
      setCode(snippet.code);
    } else {
      setEditingSnippet(null);
      setName("");
      setCategory("");
      setDescription("");
      setCode("");
    }
    setIsDialogOpen(true);
  };

  const handleSave = async () => {
    try {
      const data = { name, category, description, code };
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

  const currentTags = extractTags(code);

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
            <Card key={snippet.id} className="glass-panel flex flex-col">
              <CardHeader className="flex flex-row items-start justify-between pb-4">
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
        <DialogContent className="max-w-2xl">
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
            <div className="space-y-2">
              <div className="flex justify-between">
                <Label>Script Code</Label>
                <span className="text-xs text-muted-foreground">Use {'{{VAR_NAME}}'} for variables</span>
              </div>
              <Textarea 
                value={code} 
                onChange={e => setCode(e.target.value)} 
                className="h-48 font-mono text-sm"
                placeholder="/system identity set name={{HOSTNAME}}"
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
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setIsDialogOpen(false)}>Cancel</Button>
            <Button onClick={handleSave} disabled={!name || !category || !code}>Save Snippet</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
