import { useState, useMemo, useRef, useCallback, useEffect } from "react";
import { useListGroups, useListRouters, useGetGroup, useGetGroupsCounts, getListGroupsQueryKey, getGetGroupQueryKey, getGetGroupsCountsQueryKey } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { useGroupsMutations } from "@/hooks/use-mutations";
import { useSelection } from "@/hooks/use-selection";
import { useConfirm } from "@/components/confirm-dialog";
import { SelectionBar } from "@/components/selection-bar";
import { FilterSortBar, ActiveSort } from "@/components/filter-sort-bar";
import { Card, CardContent } from "@/components/ui/card";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Skeleton } from "@/components/ui/skeleton";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Plus, Network, Folder, Server, ChevronRight, ChevronDown, Trash2, Edit2, Link as LinkIcon, Unlink, Search, MoveRight, GripVertical, ExternalLink } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/contexts/auth-context";
import { useLocation } from "wouter";
import { cn } from "@/lib/utils";

type DragItem = { type: "group"; id: number } | { type: "device"; id: number; name: string } | null;

export default function Groups() {
  const { data: groups = [], isLoading } = useListGroups();
  const { data: routers = [] } = useListRouters();
  const { data: groupsCounts } = useGetGroupsCounts();
  const { createGroup, updateGroup, deleteGroup, addMember, removeMember } = useGroupsMutations();
  const queryClient = useQueryClient();
  const { user } = useAuth();
  const [, navigate] = useLocation();
  const { toast } = useToast();
  const confirmDialog = useConfirm();

  const [expandedGroups, setExpandedGroups] = useState<Set<number>>(new Set());
  const [selectedGroup, setSelectedGroup] = useState<number | null>(null);
  const [isGroupDialogOpen, setIsGroupDialogOpen] = useState(false);
  const [isMemberDialogOpen, setIsMemberDialogOpen] = useState(false);
  const [editingGroup, setEditingGroup] = useState<any>(null);
  const [isBulkDeleting, setIsBulkDeleting] = useState(false);
  const [groupSearch, setGroupSearch] = useState("");
  const [selectedDeviceIds, setSelectedDeviceIds] = useState<Set<number>>(new Set());
  const [isBulkRemoving, setIsBulkRemoving] = useState(false);

  useEffect(() => { setSelectedDeviceIds(new Set()); }, [selectedGroup]);

  const [formName, setFormName] = useState("");
  const [formDesc, setFormDesc] = useState("");
  const [isMoveDialogOpen, setIsMoveDialogOpen] = useState(false);
  const [moveTargetParentId, setMoveTargetParentId] = useState<number | null>(null);
  const [moveSearch, setMoveSearch] = useState("");
  const [isMoving, setIsMoving] = useState(false);
  const [dragGroupId, setDragGroupId] = useState<number | null>(null);
  const [dropTargetId, setDropTargetId] = useState<number | null | "root">(null);
  const [dragItem, setDragItem] = useState<DragItem>(null);

  const storageKey = `groups-panel-width-${user?.id ?? "default"}`;
  const containerRef = useRef<HTMLDivElement>(null);
  const isResizing = useRef(false);
  const [leftPanelPct, setLeftPanelPct] = useState<number>(() => {
    try {
      const saved = localStorage.getItem(storageKey);
      if (saved) { const n = parseFloat(saved); if (n >= 15 && n <= 70) return n; }
    } catch {}
    return 33;
  });

  useEffect(() => {
    try { localStorage.setItem(storageKey, String(leftPanelPct)); } catch {}
  }, [leftPanelPct, storageKey]);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    isResizing.current = true;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";

    const onMouseMove = (ev: MouseEvent) => {
      if (!isResizing.current || !containerRef.current) return;
      const rect = containerRef.current.getBoundingClientRect();
      const pct = ((ev.clientX - rect.left) / rect.width) * 100;
      setLeftPanelPct(Math.max(15, Math.min(70, pct)));
    };

    const onMouseUp = () => {
      isResizing.current = false;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
    };

    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
  }, []);
  
  const [memberType, setMemberType] = useState<"router"|"group">("router");
  const [memberId, setMemberId] = useState<string>("");
  const [selectedMemberIds, setSelectedMemberIds] = useState<Set<number>>(new Set());
  const [memberSearch, setMemberSearch] = useState("");

  const { data: groupDetails } = useGetGroup(selectedGroup!, { query: { queryKey: getGetGroupQueryKey(selectedGroup!), enabled: !!selectedGroup } });

  const selection = useSelection(groups.map(g => g.id));

  const selectGroup = (id: number) => {
    setSelectedGroup(id);
  };

  const toggleExpand = (id: number, e: React.MouseEvent) => {
    e.stopPropagation();
    const next = new Set(expandedGroups);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setExpandedGroups(next);
  };

  const navigateToGroup = (groupId: number) => {
    const ancestors = new Set<number>();
    let current = groups.find(g => g.id === groupId);
    while (current && current.parentId != null) {
      ancestors.add(current.parentId);
      current = groups.find(g => g.id === current!.parentId);
    }
    setExpandedGroups(prev => {
      const next = new Set(prev);
      ancestors.forEach(id => next.add(id));
      return next;
    });
    setSelectedGroup(groupId);
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
    const ok = await confirmDialog({ title: "Remove Member", description: "Remove this member from the group?", confirmLabel: "Remove", variant: "destructive" });
    if (!ok) return;
    try {
      await removeMember.mutateAsync({ id: selectedGroup, data: { type, memberId: id } });
      toast({ title: "Member removed" });
    } catch (e: any) {
      toast({ title: "Error", description: e.message, variant: "destructive" });
    }
  };

  const handleBulkRemoveDevices = async () => {
    if (!selectedGroup || selectedDeviceIds.size === 0) return;
    const ok = await confirmDialog({ title: "Remove Devices", description: `Remove ${selectedDeviceIds.size} device${selectedDeviceIds.size !== 1 ? "s" : ""} from this group?`, confirmLabel: "Remove All", variant: "destructive" });
    if (!ok) return;
    setIsBulkRemoving(true);
    try {
      for (const deviceId of selectedDeviceIds) {
        await removeMember.mutateAsync({ id: selectedGroup, data: { type: "router", memberId: deviceId } });
      }
      toast({ title: `${selectedDeviceIds.size} device${selectedDeviceIds.size !== 1 ? "s" : ""} removed` });
      setSelectedDeviceIds(new Set());
    } catch (e: any) {
      toast({ title: "Error", description: e.message, variant: "destructive" });
    } finally {
      setIsBulkRemoving(false);
    }
  };

  const toggleDeviceSelection = (id: number) => {
    setSelectedDeviceIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const handleDeleteGroup = async (id: number, e: React.MouseEvent) => {
    e.stopPropagation();
    const ok = await confirmDialog({ title: "Delete Group", description: "Are you sure you want to delete this group? This action cannot be undone.", confirmLabel: "Delete", variant: "destructive" });
    if (!ok) return;
    try {
      await deleteGroup.mutateAsync({ id });
      if (selectedGroup === id) setSelectedGroup(null);
      toast({ title: "Group deleted" });
    } catch (e: any) {
      toast({ title: "Error", description: e.message, variant: "destructive" });
    }
  };

  const getDescendantIds = (groupId: number): Set<number> => {
    const descendants = new Set<number>();
    const walk = (parentId: number) => {
      groups.filter(g => g.parentId === parentId).forEach(g => {
        descendants.add(g.id);
        walk(g.id);
      });
    };
    walk(groupId);
    return descendants;
  };

  const handleMoveGroup = async () => {
    if (!selectedGroup) return;
    const currentGroup = groups.find(g => g.id === selectedGroup);
    const oldParentId = currentGroup?.parentId ?? null;
    setIsMoving(true);
    try {
      const baseUrl = import.meta.env.BASE_URL || "/";
      const res = await fetch(`${baseUrl}api/groups/${selectedGroup}/move`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ newParentId: moveTargetParentId }),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || "Move failed");
      }
      toast({ title: "Group moved successfully" });
      setIsMoveDialogOpen(false);
      queryClient.invalidateQueries({ queryKey: getListGroupsQueryKey() });
      queryClient.invalidateQueries({ queryKey: getGetGroupQueryKey(selectedGroup) });
      if (oldParentId !== null) queryClient.invalidateQueries({ queryKey: getGetGroupQueryKey(oldParentId) });
      if (moveTargetParentId !== null) queryClient.invalidateQueries({ queryKey: getGetGroupQueryKey(moveTargetParentId) });
      queryClient.invalidateQueries({ queryKey: getGetGroupsCountsQueryKey() });
    } catch (e: any) {
      toast({ title: "Error moving group", description: e.message, variant: "destructive" });
    } finally {
      setIsMoving(false);
    }
  };

  const handleDragDrop = async (draggedId: number, targetParentId: number | null) => {
    const draggedGroup = groups.find(g => g.id === draggedId);
    if (!draggedGroup) return;
    const oldParentId = draggedGroup.parentId ?? null;
    if (oldParentId === targetParentId) return;
    if (targetParentId === draggedId) return;
    const descendants = getDescendantIds(draggedId);
    if (targetParentId !== null && descendants.has(targetParentId)) return;

    setIsMoving(true);
    try {
      const baseUrl = import.meta.env.BASE_URL || "/";
      const res = await fetch(`${baseUrl}api/groups/${draggedId}/move`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ newParentId: targetParentId }),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || "Move failed");
      }
      toast({ title: "Group moved successfully" });
      queryClient.invalidateQueries({ queryKey: getListGroupsQueryKey() });
      if (oldParentId !== null) queryClient.invalidateQueries({ queryKey: getGetGroupQueryKey(oldParentId) });
      if (targetParentId !== null) queryClient.invalidateQueries({ queryKey: getGetGroupQueryKey(targetParentId) });
      if (selectedGroup) queryClient.invalidateQueries({ queryKey: getGetGroupQueryKey(selectedGroup) });
      queryClient.invalidateQueries({ queryKey: getGetGroupsCountsQueryKey() });
    } catch (e: any) {
      toast({ title: "Error moving group", description: e.message, variant: "destructive" });
    } finally {
      setIsMoving(false);
      setDragGroupId(null);
      setDropTargetId(null);
    }
  };

  const handleDropDeviceOnGroup = async (deviceId: number, targetGroupId: number) => {
    try {
      await addMember.mutateAsync({ id: targetGroupId, data: { type: "router", memberId: deviceId } });
      toast({ title: "Device added to group" });
      queryClient.invalidateQueries({ queryKey: getListGroupsQueryKey() });
      queryClient.invalidateQueries({ queryKey: getGetGroupQueryKey(targetGroupId) });
      if (selectedGroup && selectedGroup !== targetGroupId) queryClient.invalidateQueries({ queryKey: getGetGroupQueryKey(selectedGroup) });
    } catch (e: any) {
      toast({ title: "Error adding device", description: e.message, variant: "destructive" });
    }
  };

  const handleBulkDelete = async () => {
    const ok = await confirmDialog({ title: "Delete Groups", description: `Delete ${selection.count} selected group(s)? This action cannot be undone.`, confirmLabel: "Delete All", variant: "destructive" });
    if (!ok) return;
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

  const matchingGroupIds = useMemo(() => {
    if (!groupSearch) return null;
    const ids = new Set<number>();
    const addAncestors = (gId: number | null) => {
      if (gId === null) return;
      const g = groups.find(x => x.id === gId);
      if (g) { ids.add(g.id); addAncestors(g.parentId ?? null); }
    };
    groups.forEach(g => {
      if (g.name.toLowerCase().includes(groupSearch.toLowerCase())) {
        ids.add(g.id);
        addAncestors(g.parentId ?? null);
      }
    });
    return ids;
  }, [groups, groupSearch]);

  const isValidDropTarget = (targetId: number | null): boolean => {
    if (dragGroupId === null) return false;
    if (targetId === dragGroupId) return false;
    const draggedGroup = groups.find(g => g.id === dragGroupId);
    if (!draggedGroup) return false;
    if ((draggedGroup.parentId ?? null) === targetId) return false;
    if (targetId !== null) {
      const descendants = getDescendantIds(dragGroupId);
      if (descendants.has(targetId)) return false;
    }
    return true;
  };

  const renderTree = (parentId: number | null, depth = 0) => {
    let children = groups.filter(g => g.parentId === parentId);
    if (matchingGroupIds) children = children.filter(g => matchingGroupIds.has(g.id));
    if (children.length === 0) return null;

    return (
      <div className="space-y-1">
        {children.map(group => {
          const isExpanded = expandedGroups.has(group.id);
          const isSelected = selectedGroup === group.id;
          const isDragging = dragGroupId === group.id || (dragItem?.type === "group" && dragItem.id === group.id);
          const isDropTarget = dropTargetId === group.id && (isValidDropTarget(group.id) || dragItem !== null);
          return (
            <div key={group.id}>
              <div 
                onClick={() => selectGroup(group.id)}
                onDragOver={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  if (dragGroupId !== null && isValidDropTarget(group.id)) {
                    setDropTargetId(group.id);
                  } else if (dragItem !== null) {
                    setDropTargetId(group.id);
                  }
                }}
                onDragLeave={(e) => {
                  if (dropTargetId === group.id) setDropTargetId(null);
                }}
                onDrop={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  if (dragGroupId !== null && isValidDropTarget(group.id)) {
                    handleDragDrop(dragGroupId, group.id);
                  } else if (dragItem?.type === "group" && dragItem.id !== group.id) {
                    handleDragDrop(dragItem.id, group.id);
                  } else if (dragItem?.type === "device") {
                    handleDropDeviceOnGroup(dragItem.id, group.id);
                  }
                  setDropTargetId(null);
                  setDragItem(null);
                }}
                className={cn(
                  "flex items-center justify-between px-3 py-2 rounded-lg cursor-pointer transition-colors border",
                  isSelected ? "bg-primary/10 border-primary/30" : "bg-transparent border-transparent hover:bg-white/5",
                  isDragging && "opacity-40",
                  isDropTarget && "border-primary bg-primary/10 ring-1 ring-primary/40",
                )}
                style={{ marginLeft: `${depth * 1.5}rem` }}
              >
                <div className="flex items-center gap-2">
                  <div
                    draggable
                    onDragStart={(e) => {
                      e.stopPropagation();
                      setDragGroupId(group.id);
                      e.dataTransfer.effectAllowed = "move";
                    }}
                    onDragEnd={() => {
                      setDragGroupId(null);
                      setDropTargetId(null);
                    }}
                    className="cursor-grab active:cursor-grabbing touch-none"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <GripVertical className="w-4 h-4 text-muted-foreground/50 hover:text-muted-foreground" />
                  </div>
                  <div onClick={(e) => e.stopPropagation()}>
                    <Checkbox
                      checked={selection.selected.has(group.id)}
                      onCheckedChange={() => selection.toggle(group.id)}
                      aria-label={`Select ${group.name}`}
                    />
                  </div>
                  {groups.some(g => g.parentId === group.id) ? (
                    <button type="button" onClick={(e) => toggleExpand(group.id, e)} className="cursor-pointer hover:text-primary hover:bg-white/10 p-1 -m-1 rounded flex items-center justify-center" aria-label={isExpanded ? "Collapse group" : "Expand group"}>
                      {isExpanded ? <ChevronDown className="w-4 h-4 text-muted-foreground" /> : <ChevronRight className="w-4 h-4 text-muted-foreground" />}
                    </button>
                  ) : <div className="w-4" />}
                  <Folder className={cn("w-4 h-4", isSelected ? "text-primary" : "text-muted-foreground")} />
                  <span className={cn("text-sm font-medium", isSelected && "text-primary")}>{group.name}</span>
                  {groupsCounts && groupsCounts[group.id] && (groupsCounts[group.id].subgroups > 0 || groupsCounts[group.id].devices > 0) && (
                    <span className="flex items-center gap-1.5 ml-1.5 text-[11px] text-muted-foreground/70 tabular-nums">
                      {groupsCounts[group.id].subgroups > 0 && (
                        <span title={`${groupsCounts[group.id].subgroups} sub-group${groupsCounts[group.id].subgroups > 1 ? "s" : ""}`} className="flex items-center gap-0.5">
                          <Folder className="w-3 h-3" />{groupsCounts[group.id].subgroups}
                        </span>
                      )}
                      {groupsCounts[group.id].devices > 0 && (
                        <span title={`${groupsCounts[group.id].devices} device${groupsCounts[group.id].devices > 1 ? "s" : ""}`} className="flex items-center gap-0.5">
                          <Server className="w-3 h-3" />{groupsCounts[group.id].devices}
                        </span>
                      )}
                    </span>
                  )}
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
          <h1 className="text-3xl font-bold tracking-tight">Device Groups</h1>
          <p className="text-muted-foreground mt-1">Organize your devices into logical groups.</p>
        </div>
        <Button onClick={() => { setEditingGroup(null); setFormName(""); setFormDesc(""); setIsGroupDialogOpen(true); }}>
          <Plus className="w-4 h-4 mr-2" /> New Root Group
        </Button>
      </div>

      <FilterSortBar
        searchValue={groupSearch}
        onSearchChange={setGroupSearch}
        searchPlaceholder="Search groups by name..."
      />

      <SelectionBar count={selection.count} label="groups" onDelete={handleBulkDelete} onClear={selection.clear} isDeleting={isBulkDeleting} />

      <div ref={containerRef} className="flex flex-col md:flex-row gap-0 h-[400px] md:h-[600px]">
        <Card className="glass-panel flex flex-col overflow-hidden h-full md:h-auto" style={{ width: `${leftPanelPct}%`, minWidth: "150px" }}>
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
            <div
              onDragOver={(e) => {
                e.preventDefault();
                if (dragGroupId !== null && isValidDropTarget(null)) setDropTargetId("root");
                else if (dragItem?.type === "group") setDropTargetId("root");
              }}
              onDragLeave={() => { if (dropTargetId === "root") setDropTargetId(null); }}
              onDrop={(e) => {
                e.preventDefault();
                if (dragGroupId !== null && isValidDropTarget(null)) handleDragDrop(dragGroupId, null);
                else if (dragItem?.type === "group") { handleDragDrop(dragItem.id, null); setDragItem(null); }
                setDropTargetId(null);
              }}
              className={cn(
                "flex items-center gap-2 px-3 py-2 mb-2 rounded-lg border border-dashed transition-colors",
                dropTargetId === "root"
                  ? "border-primary bg-primary/10 text-primary"
                  : "border-muted-foreground/20 text-muted-foreground"
              )}
            >
              <Network className="w-4 h-4" />
              <span className="text-xs font-medium">Root level — drag a group here to make it top-level</span>
            </div>
            {isLoading ? (
              <div className="space-y-2 py-2">
                {Array.from({ length: 4 }).map((_, i) => (
                  <div key={i} className="flex items-center gap-3 px-2">
                    <Skeleton className="h-4 w-4 rounded" />
                    <Skeleton className="h-5 w-5 rounded" />
                    <Skeleton className="h-4 w-32" />
                  </div>
                ))}
              </div>
            ) : renderTree(null)}
            {!isLoading && groups.length === 0 && (
              <div className="text-center py-12">
                <Network className="w-10 h-10 mx-auto text-muted-foreground/30 mb-3" />
                <p className="text-muted-foreground text-sm">No groups created yet.</p>
              </div>
            )}
          </CardContent>
        </Card>

        <div
          onMouseDown={handleMouseDown}
          className="hidden md:flex items-center justify-center w-2 cursor-col-resize group/resizer hover:bg-primary/10 transition-colors flex-shrink-0"
          aria-label="Resize panels"
        >
          <div className="w-0.5 h-12 rounded-full bg-border group-hover/resizer:bg-primary transition-colors" />
        </div>

        <Card className="glass-panel flex-1 flex flex-col overflow-hidden h-full md:h-auto" style={{ minWidth: "200px" }}>
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
                  <Button variant="outline" size="sm" onClick={() => { setMoveTargetParentId(groupDetails.parentId ?? null); setMoveSearch(""); setIsMoveDialogOpen(true); }}>
                    <MoveRight className="w-4 h-4 mr-1" /> Move
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
                        <div
                          key={`g-${sub.id}`}
                          className={cn(
                            "flex items-center justify-between p-3 rounded-xl bg-background border border-border/50 hover:border-primary/30 hover:bg-primary/5 transition-colors cursor-pointer group/item",
                            dragItem?.type === "group" && dragItem.id === sub.id && "opacity-40"
                          )}
                          onClick={() => navigateToGroup(sub.id)}
                        >
                          <div className="flex items-center gap-3">
                            <div
                              draggable
                              onDragStart={(e) => {
                                e.stopPropagation();
                                setDragItem({ type: "group", id: sub.id });
                                e.dataTransfer.effectAllowed = "move";
                              }}
                              onDragEnd={() => { setDragItem(null); setDropTargetId(null); }}
                              className="cursor-grab active:cursor-grabbing touch-none"
                              onClick={(e) => e.stopPropagation()}
                            >
                              <GripVertical className="w-4 h-4 text-muted-foreground/50 hover:text-muted-foreground" />
                            </div>
                            <Folder className="w-5 h-5 text-purple-400" />
                            <span className="text-sm font-medium group-hover/item:text-primary transition-colors">{sub.name}</span>
                          </div>
                          <div className="flex items-center gap-1">
                            <ExternalLink className="w-3.5 h-3.5 text-muted-foreground/0 group-hover/item:text-muted-foreground/60 transition-colors" />
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <Button variant="ghost" size="icon" className="h-8 w-8 text-destructive" onClick={(e) => { e.stopPropagation(); handleRemoveMember("group", sub.id); }}>
                                  <Unlink className="w-4 h-4" />
                                </Button>
                              </TooltipTrigger>
                              <TooltipContent side="top">
                                {groupDetails.parentId ? `Detach from this group — moves up to "${groups.find(g => g.id === groupDetails.parentId)?.name ?? "parent"}"` : "Detach from this group — moves to root level"}
                              </TooltipContent>
                            </Tooltip>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                <div>
                  <div className="flex items-center justify-between mb-3">
                    <h4 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider">Devices ({groupDetails.routers.length})</h4>
                    {groupDetails.routers.length > 0 && (
                      <div className="flex items-center gap-2">
                        <label className="flex items-center gap-1.5 cursor-pointer">
                          <Checkbox
                            checked={groupDetails.routers.length > 0 && selectedDeviceIds.size === groupDetails.routers.length}
                            onCheckedChange={(checked) => {
                              if (checked) {
                                setSelectedDeviceIds(new Set(groupDetails.routers.map(r => r.id)));
                              } else {
                                setSelectedDeviceIds(new Set());
                              }
                            }}
                            {...(selectedDeviceIds.size > 0 && selectedDeviceIds.size < groupDetails.routers.length ? { "data-state": "indeterminate" as any } : {})}
                          />
                          <span className="text-xs text-muted-foreground">
                            {selectedDeviceIds.size === groupDetails.routers.length ? "Deselect all" : "Select all"}
                          </span>
                        </label>
                        {selectedDeviceIds.size > 0 && (
                          <Button
                            variant="destructive"
                            size="sm"
                            className="h-7 text-xs"
                            disabled={isBulkRemoving}
                            onClick={handleBulkRemoveDevices}
                          >
                            <Unlink className="w-3.5 h-3.5 mr-1" />
                            {isBulkRemoving ? "Removing..." : `Remove ${selectedDeviceIds.size}`}
                          </Button>
                        )}
                      </div>
                    )}
                  </div>
                  {groupDetails.routers.length === 0 ? (
                    <p className="text-sm text-muted-foreground italic">No devices attached.</p>
                  ) : (
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                      {groupDetails.routers.map(router => (
                        <div
                          key={`r-${router.id}`}
                          className={cn(
                            "flex items-center justify-between p-3 rounded-xl bg-background border border-border/50 hover:border-blue-400/30 hover:bg-blue-400/5 transition-colors cursor-pointer group/item",
                            dragItem?.type === "device" && dragItem.id === router.id && "opacity-40",
                            selectedDeviceIds.has(router.id) && "border-destructive/40 bg-destructive/5"
                          )}
                          onClick={() => navigate("/routers")}
                        >
                          <div className="flex items-center gap-3">
                            <Checkbox
                              checked={selectedDeviceIds.has(router.id)}
                              onCheckedChange={() => toggleDeviceSelection(router.id)}
                              onClick={(e) => e.stopPropagation()}
                            />
                            <div
                              draggable
                              onDragStart={(e) => {
                                e.stopPropagation();
                                setDragItem({ type: "device", id: router.id, name: router.name });
                                e.dataTransfer.effectAllowed = "copy";
                              }}
                              onDragEnd={() => { setDragItem(null); setDropTargetId(null); }}
                              className="cursor-grab active:cursor-grabbing touch-none"
                              onClick={(e) => e.stopPropagation()}
                            >
                              <GripVertical className="w-4 h-4 text-muted-foreground/50 hover:text-muted-foreground" />
                            </div>
                            <Server className="w-5 h-5 text-blue-400" />
                            <div className="flex flex-col">
                              <span className="text-sm font-medium leading-none group-hover/item:text-blue-400 transition-colors">{router.name}</span>
                              <span className="text-xs text-muted-foreground mt-1">{router.ipAddress}</span>
                            </div>
                          </div>
                          <div className="flex items-center gap-1">
                            <ExternalLink className="w-3.5 h-3.5 text-muted-foreground/0 group-hover/item:text-muted-foreground/60 transition-colors" />
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <Button variant="ghost" size="icon" className="h-8 w-8 text-destructive" onClick={(e) => { e.stopPropagation(); handleRemoveMember("router", router.id); }}>
                                  <Unlink className="w-4 h-4" />
                                </Button>
                              </TooltipTrigger>
                              <TooltipContent side="top">Remove device from this group</TooltipContent>
                            </Tooltip>
                          </div>
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
                <option value="router">Devices</option>
                <option value="group">Sub-Groups</option>
              </select>
            </div>
            <div className="space-y-2">
              <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                <Input
                  placeholder={`Search ${memberType === "router" ? "devices" : "groups"}...`}
                  value={memberSearch}
                  onChange={e => setMemberSearch(e.target.value)}
                  className="pl-9 bg-black/40 border-white/5"
                />
              </div>
              {(() => {
                const available = memberType === "router"
                  ? routers
                      .filter(r => !groupDetails?.routers.find(gr => gr.id === r.id))
                      .filter(r => {
                        if (!memberSearch) return true;
                        const s = memberSearch.toLowerCase();
                        return r.name.toLowerCase().includes(s) || r.ipAddress.toLowerCase().includes(s) || (r.description ?? "").toLowerCase().includes(s);
                      })
                  : groups
                      .filter(g => g.id !== selectedGroup && !groupDetails?.subGroups.find(sg => sg.id === g.id))
                      .filter(g => {
                        if (!memberSearch) return true;
                        const s = memberSearch.toLowerCase();
                        return g.name.toLowerCase().includes(s) || (g.description ?? "").toLowerCase().includes(s);
                      });

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
                          {memberSearch ? "No matching items" : `All ${memberType === "router" ? "devices" : "groups"} are already members`}
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

      <Dialog open={isMoveDialogOpen} onOpenChange={setIsMoveDialogOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <MoveRight className="w-5 h-5 text-primary" />
              Move "{groupDetails?.name}"
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <Label>Select new parent</Label>
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
              <Input
                placeholder="Search groups..."
                value={moveSearch}
                onChange={e => setMoveSearch(e.target.value)}
                className="pl-9 bg-black/40 border-white/5"
              />
            </div>
            <div className="border border-white/5 rounded-lg max-h-60 overflow-y-auto divide-y divide-white/5">
              {!moveSearch && (
                <label
                  className={cn(
                    "flex items-center gap-3 px-3 py-2.5 cursor-pointer hover:bg-white/5 transition-colors",
                    moveTargetParentId === null && "bg-primary/10"
                  )}
                  onClick={() => setMoveTargetParentId(null)}
                >
                  <input type="radio" checked={moveTargetParentId === null} onChange={() => setMoveTargetParentId(null)} className="accent-primary" />
                  <Network className="w-4 h-4 text-muted-foreground" />
                  <span className="text-sm font-medium">Root (no parent)</span>
                </label>
              )}
              {(() => {
                const disabledIds = selectedGroup ? getDescendantIds(selectedGroup) : new Set<number>();
                disabledIds.add(selectedGroup!);
                const filtered = groups
                  .filter(g => !disabledIds.has(g.id))
                  .filter(g => {
                    if (!moveSearch) return true;
                    const s = moveSearch.toLowerCase();
                    return g.name.toLowerCase().includes(s) || (g.description ?? "").toLowerCase().includes(s);
                  });
                return filtered.length === 0 && moveSearch ? (
                  <div className="p-6 text-center text-sm text-muted-foreground">No matching groups</div>
                ) : (
                  filtered.map(g => (
                    <label
                      key={g.id}
                      className={cn(
                        "flex items-center gap-3 px-3 py-2.5 cursor-pointer hover:bg-white/5 transition-colors",
                        moveTargetParentId === g.id && "bg-primary/10"
                      )}
                      onClick={() => setMoveTargetParentId(g.id)}
                    >
                      <input type="radio" checked={moveTargetParentId === g.id} onChange={() => setMoveTargetParentId(g.id)} className="accent-primary" />
                      <Folder className="w-4 h-4 text-muted-foreground" />
                      <span className="text-sm font-medium">{g.name}</span>
                      {g.parentId !== null && (
                        <span className="text-xs text-muted-foreground ml-auto">
                          in {groups.find(p => p.id === g.parentId)?.name || "..."}
                        </span>
                      )}
                    </label>
                  ))
                );
              })()}
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setIsMoveDialogOpen(false)}>Cancel</Button>
            <Button onClick={handleMoveGroup} disabled={isMoving || moveTargetParentId === (groupDetails?.parentId ?? null)}>
              {isMoving ? "Moving..." : "Move Group"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
