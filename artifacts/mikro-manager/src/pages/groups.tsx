import { useState } from "react";
import { useListGroups, useListRouters, useGetGroup } from "@workspace/api-client-react";
import { useGroupsMutations } from "@/hooks/use-mutations";
import { useSelection } from "@/hooks/use-selection";
import { SelectionBar } from "@/components/selection-bar";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Plus, Network, Folder, Server, ChevronRight, ChevronDown, Trash2, Edit2, Link as LinkIcon, Unlink, Search } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";

export default function Groups() {
  const { data: groups = [], isLoading } = useListGroups();
  const { data: routers = [] } = useListRouters();
  const { createGroup, updateGroup, deleteGroup, addMember, removeMember } = useGroupsMutations();
  const { toast } = useToast();

  const [expandedGroups, setExpandedGroups] = useState<Set<number>>(new Set());
  const [selectedGroup, setSelectedGroup] = useState<number | null>(null);
  const [isGroupDialogOpen, setIsGroupDialogOpen] = useState(false);
  const [isMemberDialogOpen, setIsMemberDialogOpen] = useState(false);
  const [editingGroup, setEditingGroup] = useState<any>(null);
  const [isBulkDeleting, setIsBulkDeleting] = useState(false);

  const [formName, setFormName] = useState("");
  const [formDesc, setFormDesc] = useState("");
  
  const [memberType, setMemberType] = useState<"router"|"group">("router");
  const [memberId, setMemberId] = useState<string>("");
  const [selectedMemberIds, setSelectedMemberIds] = useState<Set<number>>(new Set());
  const [memberSearch, setMemberSearch] = useState("");

  const { data: groupDetails } = useGetGroup(selectedGroup!, { query: { enabled: !!selectedGroup } });

  const selection = useSelection(groups.map(g => g.id));

  const toggleGroup = (id: number) => {
    const next = new Set(expandedGroups);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setExpandedGroups(next);
    setSelectedGroup(id);
  };

  const handleSaveGroup = async () => {
    try {
      if (editingGroup) {
        await updateGroup.mutateAsync({ id: editingGroup.id, data: { name: formName, description: formDesc } });
        toast({ title: "Group updated" });
      } else {
        await createGroup.mutateAsync({ data: { name: formName, description: formDesc, parentId: null } });
        toast({ title: "Group created" });
      }
      setIsGroupDialogOpen(false);
    } catch (e: any) {
      toast({ title: "Error", description: e.message, variant: "destructive" });
    }
  };

  const handleAddMember = async () => {
    if (!selectedGroup || selectedMemberIds.size === 0) return;
    try {
      const ids = Array.from(selectedMemberIds);
      await Promise.all(ids.map(mid =>
        addMember.mutateAsync({
          id: selectedGroup,
          data: { type: memberType, memberId: mid }
        })
      ));
      toast({ title: `${ids.length} member(s) added` });
      setIsMemberDialogOpen(false);
      setSelectedMemberIds(new Set());
      setMemberSearch("");
    } catch (e: any) {
      toast({ title: "Error", description: e.message, variant: "destructive" });
    }
  };

  const handleRemoveMember = async (type: "router"|"group", id: number) => {
    if (!selectedGroup) return;
    if (confirm("Remove this member?")) {
      try {
        await removeMember.mutateAsync({ id: selectedGroup, data: { type, memberId: id } });
        toast({ title: "Member removed" });
      } catch (e: any) {
        toast({ title: "Error", description: e.message, variant: "destructive" });
      }
    }
  };

  const handleDeleteGroup = async (id: number, e: React.MouseEvent) => {
    e.stopPropagation();
    if (confirm("Delete this group?")) {
      try {
        await deleteGroup.mutateAsync({ id });
        if (selectedGroup === id) setSelectedGroup(null);
        toast({ title: "Group deleted" });
      } catch (e: any) {
        toast({ title: "Error", description: e.message, variant: "destructive" });
      }
    }
  };

  const handleBulkDelete = async () => {
    if (!confirm(`Delete ${selection.count} selected group(s)?`)) return;
    setIsBulkDeleting(true);
    try {
      await Promise.all(selection.ids.map(id => deleteGroup.mutateAsync({ id })));
      toast({ title: `${selection.count} group(s) deleted` });
      selection.clear();
      setSelectedGroup(null);
    } catch (err: any) {
      toast({ title: "Error deleting groups", description: err.message, variant: "destructive" });
    } finally {
      setIsBulkDeleting(false);
    }
  };

  const renderTree = (parentId: number | null, depth = 0) => {
    const children = groups.filter(g => g.parentId === parentId);
    if (children.length === 0) return null;

    return (
      <div className="space-y-1">
        {children.map(group => {
          const isExpanded = expandedGroups.has(group.id);
          const isSelected = selectedGroup === group.id;
          return (
            <div key={group.id}>
              <div 
                onClick={() => toggleGroup(group.id)}
                className={cn(
                  "flex items-center justify-between px-3 py-2 rounded-lg cursor-pointer transition-colors border",
                  isSelected ? "bg-primary/10 border-primary/30" : "bg-transparent border-transparent hover:bg-white/5",
                )}
                style={{ marginLeft: `${depth * 1.5}rem` }}
              >
                <div className="flex items-center gap-2">
                  <div onClick={(e) => e.stopPropagation()}>
                    <Checkbox
                      checked={selection.selected.has(group.id)}
                      onCheckedChange={() => selection.toggle(group.id)}
                      aria-label={`Select ${group.name}`}
                    />
                  </div>
                  {groups.some(g => g.parentId === group.id) ? (
                    isExpanded ? <ChevronDown className="w-4 h-4 text-muted-foreground" /> : <ChevronRight className="w-4 h-4 text-muted-foreground" />
                  ) : <div className="w-4" />}
                  <Folder className={cn("w-4 h-4", isSelected ? "text-primary" : "text-muted-foreground")} />
                  <span className={cn("text-sm font-medium", isSelected && "text-primary")}>{group.name}</span>
                </div>
                <Button variant="ghost" size="icon" className="h-6 w-6 text-muted-foreground hover:text-destructive" onClick={(e) => handleDeleteGroup(group.id, e)}>
                  <Trash2 className="w-3 h-3" />
                </Button>
              </div>
              {isExpanded && renderTree(group.id, depth + 1)}
            </div>
          );
        })}
      </div>
    );
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Router Groups</h1>
          <p className="text-muted-foreground mt-1">Organize your devices into logical groups.</p>
        </div>
        <Button onClick={() => { setEditingGroup(null); setFormName(""); setFormDesc(""); setIsGroupDialogOpen(true); }}>
          <Plus className="w-4 h-4 mr-2" /> New Root Group
        </Button>
      </div>

      <SelectionBar count={selection.count} label="groups" onDelete={handleBulkDelete} onClear={selection.clear} isDeleting={isBulkDeleting} />

      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        <Card className="glass-panel md:col-span-1 h-[400px] md:h-[600px] flex flex-col">
          <div className="p-4 border-b border-border/50 bg-black/20 font-medium flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Network className="w-4 h-4 text-primary" /> Directory
            </div>
            {groups.length > 0 && (
              <Checkbox
                checked={selection.isAllSelected}
                onCheckedChange={selection.toggleAll}
                aria-label="Select all groups"
                {...(selection.isSomeSelected ? { "data-state": "indeterminate" as any } : {})}
              />
            )}
          </div>
          <CardContent className="p-4 flex-1 overflow-y-auto">
            {isLoading ? <p className="text-muted-foreground text-sm">Loading...</p> : renderTree(null)}
            {!isLoading && groups.length === 0 && <p className="text-muted-foreground text-sm text-center py-8">No groups created yet.</p>}
          </CardContent>
        </Card>

        <Card className="glass-panel md:col-span-2 h-[400px] md:h-[600px] flex flex-col">
          {selectedGroup && groupDetails ? (
            <>
              <div className="p-4 md:p-6 border-b border-border/50 bg-black/20 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                <div>
                  <h3 className="text-xl font-bold">{groupDetails.name}</h3>
                  <p className="text-sm text-muted-foreground mt-1">{groupDetails.description || "No description"}</p>
                </div>
                <div className="flex gap-2">
                  <Button variant="outline" size="sm" onClick={() => { setEditingGroup(groupDetails); setFormName(groupDetails.name); setFormDesc(groupDetails.description||""); setIsGroupDialogOpen(true); }}>
                    <Edit2 className="w-4 h-4 mr-1" /> Edit
                  </Button>
                  <Button size="sm" onClick={() => { setSelectedMemberIds(new Set()); setMemberSearch(""); setMemberType("router"); setIsMemberDialogOpen(true); }}>
                    <LinkIcon className="w-4 h-4 mr-1" /> Add
                  </Button>
                </div>
              </div>
              <CardContent className="p-6 flex-1 overflow-y-auto space-y-6">
                <div>
                  <h4 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider mb-3">Sub-Groups ({groupDetails.subGroups.length})</h4>
                  {groupDetails.subGroups.length === 0 ? (
                    <p className="text-sm text-muted-foreground italic">No sub-groups attached.</p>
                  ) : (
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                      {groupDetails.subGroups.map(sub => (
                        <div key={`g-${sub.id}`} className="flex items-center justify-between p-3 rounded-xl bg-background border border-border/50">
                          <div className="flex items-center gap-3">
                            <Folder className="w-5 h-5 text-purple-400" />
                            <span className="text-sm font-medium">{sub.name}</span>
                          </div>
                          <Button variant="ghost" size="icon" className="h-8 w-8 text-destructive" onClick={() => handleRemoveMember("group", sub.id)}>
                            <Unlink className="w-4 h-4" />
                          </Button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                <div>
                  <h4 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider mb-3">Routers ({groupDetails.routers.length})</h4>
                  {groupDetails.routers.length === 0 ? (
                    <p className="text-sm text-muted-foreground italic">No routers attached.</p>
                  ) : (
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                      {groupDetails.routers.map(router => (
                        <div key={`r-${router.id}`} className="flex items-center justify-between p-3 rounded-xl bg-background border border-border/50">
                          <div className="flex items-center gap-3">
                            <Server className="w-5 h-5 text-blue-400" />
                            <div className="flex flex-col">
                              <span className="text-sm font-medium leading-none">{router.name}</span>
                              <span className="text-xs text-muted-foreground mt-1">{router.ipAddress}</span>
                            </div>
                          </div>
                          <Button variant="ghost" size="icon" className="h-8 w-8 text-destructive" onClick={() => handleRemoveMember("router", router.id)}>
                            <Unlink className="w-4 h-4" />
                          </Button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </CardContent>
            </>
          ) : (
            <div className="flex-1 flex flex-col items-center justify-center text-muted-foreground">
              <Network className="w-16 h-16 opacity-20 mb-4" />
              <p>Select a group from the directory to view its members.</p>
            </div>
          )}
        </Card>
      </div>

      <Dialog open={isGroupDialogOpen} onOpenChange={setIsGroupDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editingGroup ? "Edit Group" : "New Group"}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label>Name</Label>
              <Input value={formName} onChange={e => setFormName(e.target.value)} placeholder="e.g. Core Network" />
            </div>
            <div className="space-y-2">
              <Label>Description</Label>
              <Input value={formDesc} onChange={e => setFormDesc(e.target.value)} placeholder="Optional description" />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setIsGroupDialogOpen(false)}>Cancel</Button>
            <Button onClick={handleSaveGroup} disabled={!formName}>Save</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={isMemberDialogOpen} onOpenChange={setIsMemberDialogOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Add Members to {groupDetails?.name}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-2">
              <Label>Member Type</Label>
              <select 
                className="flex h-10 w-full rounded-xl border border-input bg-background/50 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
                value={memberType} 
                onChange={(e: any) => { setMemberType(e.target.value); setSelectedMemberIds(new Set()); setMemberSearch(""); }}
              >
                <option value="router">Routers</option>
                <option value="group">Sub-Groups</option>
              </select>
            </div>
            <div className="space-y-2">
              <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                <Input
                  placeholder={`Search ${memberType === "router" ? "routers" : "groups"}...`}
                  value={memberSearch}
                  onChange={e => setMemberSearch(e.target.value)}
                  className="pl-9 bg-black/40 border-white/5"
                />
              </div>
              {(() => {
                const available = memberType === "router"
                  ? routers
                      .filter(r => !groupDetails?.routers.find(gr => gr.id === r.id))
                      .filter(r => !memberSearch || r.name.toLowerCase().includes(memberSearch.toLowerCase()) || r.ipAddress.includes(memberSearch))
                  : groups
                      .filter(g => g.id !== selectedGroup && !groupDetails?.subGroups.find(sg => sg.id === g.id))
                      .filter(g => !memberSearch || g.name.toLowerCase().includes(memberSearch.toLowerCase()));

                const allSelected = available.length > 0 && available.every(item => selectedMemberIds.has(item.id));
                const someSelected = available.some(item => selectedMemberIds.has(item.id));

                const toggleAll = () => {
                  if (allSelected) {
                    setSelectedMemberIds(new Set());
                  } else {
                    setSelectedMemberIds(new Set(available.map(item => item.id)));
                  }
                };

                const toggleOne = (id: number) => {
                  const next = new Set(selectedMemberIds);
                  if (next.has(id)) next.delete(id);
                  else next.add(id);
                  setSelectedMemberIds(next);
                };

                return (
                  <>
                    {available.length > 0 && (
                      <div className="flex items-center justify-between px-1 py-1">
                        <div className="flex items-center gap-2">
                          <Checkbox
                            checked={allSelected}
                            onCheckedChange={toggleAll}
                            aria-label="Select all"
                            {...(someSelected && !allSelected ? { "data-state": "indeterminate" as any } : {})}
                          />
                          <span className="text-xs text-muted-foreground">
                            {allSelected ? "Deselect all" : "Select all"} ({available.length})
                          </span>
                        </div>
                        {selectedMemberIds.size > 0 && (
                          <span className="text-xs text-primary font-medium">{selectedMemberIds.size} selected</span>
                        )}
                      </div>
                    )}
                    <div className="border border-white/5 rounded-lg max-h-60 overflow-y-auto divide-y divide-white/5">
                      {available.length === 0 ? (
                        <div className="p-6 text-center text-sm text-muted-foreground">
                          {memberSearch ? "No matching items" : `All ${memberType === "router" ? "routers" : "groups"} are already members`}
                        </div>
                      ) : (
                        available.map(item => (
                          <label
                            key={item.id}
                            className={cn(
                              "flex items-center gap-3 px-3 py-2.5 cursor-pointer hover:bg-white/5 transition-colors",
                              selectedMemberIds.has(item.id) && "bg-primary/5"
                            )}
                          >
                            <Checkbox
                              checked={selectedMemberIds.has(item.id)}
                              onCheckedChange={() => toggleOne(item.id)}
                            />
                            <div className="flex items-center gap-2 flex-1 min-w-0">
                              {memberType === "router" ? (
                                <Server className="w-4 h-4 text-muted-foreground shrink-0" />
                              ) : (
                                <Folder className="w-4 h-4 text-muted-foreground shrink-0" />
                              )}
                              <span className="text-sm font-medium truncate">{"name" in item ? item.name : ""}</span>
                              {memberType === "router" && "ipAddress" in item && (
                                <span className="text-xs font-mono text-muted-foreground ml-auto shrink-0">{(item as any).ipAddress}</span>
                              )}
                            </div>
                          </label>
                        ))
                      )}
                    </div>
                  </>
                );
              })()}
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setIsMemberDialogOpen(false)}>Cancel</Button>
            <Button onClick={handleAddMember} disabled={selectedMemberIds.size === 0 || addMember.isPending}>
              {addMember.isPending ? "Adding..." : `Add ${selectedMemberIds.size || ""} Member${selectedMemberIds.size !== 1 ? "s" : ""}`}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
