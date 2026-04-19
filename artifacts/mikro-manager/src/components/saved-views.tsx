// ─── Saved Views Dropdown ──────────────────────────────────────────
// A small reusable widget that lets users save the current page state
// (filter/sort/search) under a name and recall it later. The hosting page
// owns the `viewState` shape — this component is intentionally generic.

import { useState } from "react";
import {
  useListSavedViews,
  useCreateSavedView,
  useDeleteSavedView,
  getListSavedViewsQueryKey,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Bookmark, Save, Trash2 } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

interface SavedViewsProps<T> {
  pageKey: string;
  currentState: T;
  onApply: (state: T) => void;
}

export function SavedViews<T>({ pageKey, currentState, onApply }: SavedViewsProps<T>) {
  const { data: views = [] } = useListSavedViews({ pageKey });
  const createView = useCreateSavedView();
  const deleteView = useDeleteSavedView();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [isSaveOpen, setIsSaveOpen] = useState(false);
  const [name, setName] = useState("");

  const handleSave = async () => {
    if (!name.trim()) return;
    try {
      await createView.mutateAsync({
        data: { pageKey, name: name.trim(), viewState: currentState as any },
      });
      await queryClient.invalidateQueries({ queryKey: getListSavedViewsQueryKey({ pageKey }) });
      toast({ title: "View saved" });
      setName("");
      setIsSaveOpen(false);
    } catch (err: any) {
      toast({ title: "Failed to save view", description: String(err?.message || err), variant: "destructive" });
    }
  };

  const handleDelete = async (id: number) => {
    await deleteView.mutateAsync({ id });
    await queryClient.invalidateQueries({ queryKey: getListSavedViewsQueryKey({ pageKey }) });
  };

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" size="sm" className="gap-2" data-testid="saved-views-trigger">
            <Bookmark className="w-4 h-4" />
            Views {views.length > 0 && <span className="text-xs text-muted-foreground">({views.length})</span>}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-56">
          <DropdownMenuLabel>Saved Views</DropdownMenuLabel>
          <DropdownMenuSeparator />
          {views.length === 0 && (
            <div className="px-2 py-2 text-xs text-muted-foreground">No saved views yet</div>
          )}
          {views.map((v) => (
            <DropdownMenuItem
              key={v.id}
              className="flex items-center justify-between gap-2 cursor-pointer"
              onSelect={(e) => { e.preventDefault(); onApply(v.viewState as T); }}
            >
              <span className="truncate">{v.name}</span>
              <button
                onClick={(e) => { e.stopPropagation(); handleDelete(v.id); }}
                className="text-destructive hover:bg-destructive/10 rounded p-1"
                aria-label={`Delete ${v.name}`}
              >
                <Trash2 className="w-3 h-3" />
              </button>
            </DropdownMenuItem>
          ))}
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={(e) => { e.preventDefault(); setIsSaveOpen(true); }} className="gap-2">
            <Save className="w-4 h-4" /> Save current view…
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <Dialog open={isSaveOpen} onOpenChange={setIsSaveOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Save current view</DialogTitle>
          </DialogHeader>
          <div className="py-4 space-y-2">
            <Input
              placeholder="My favorite filter"
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoFocus
              onKeyDown={(e) => { if (e.key === "Enter") handleSave(); }}
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setIsSaveOpen(false)}>Cancel</Button>
            <Button onClick={handleSave} disabled={!name.trim() || createView.isPending}>Save</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
