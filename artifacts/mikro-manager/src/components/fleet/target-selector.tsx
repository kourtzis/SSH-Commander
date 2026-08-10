import React, { useMemo } from "react";
import { useListRouters, useListGroups } from "@workspace/api-client-react";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Search, Server, Folder } from "lucide-react";

interface TargetSelectorProps {
  selectedRouterIds: number[];
  selectedGroupIds: number[];
  onChange: (routers: number[], groups: number[]) => void;
}

export function TargetSelector({ selectedRouterIds, selectedGroupIds, onChange }: TargetSelectorProps) {
  const { data: routers = [] } = useListRouters();
  const { data: groups = [] } = useListGroups();
  
  const [search, setSearch] = React.useState("");

  const filteredRouters = useMemo(() => {
    if (!search) return routers;
    const q = search.toLowerCase();
    return routers.filter((r: any) => r.name.toLowerCase().includes(q) || r.ipAddress.includes(q));
  }, [routers, search]);

  const filteredGroups = useMemo(() => {
    if (!search) return groups;
    const q = search.toLowerCase();
    return groups.filter((g: any) => g.name.toLowerCase().includes(q));
  }, [groups, search]);

  const toggleRouter = (id: number) => {
    if (selectedRouterIds.includes(id)) {
      onChange(selectedRouterIds.filter((x: any) => x !== id), selectedGroupIds);
    } else {
      onChange([...selectedRouterIds, id], selectedGroupIds);
    }
  };

  const toggleGroup = (id: number) => {
    if (selectedGroupIds.includes(id)) {
      onChange(selectedRouterIds, selectedGroupIds.filter((x: any) => x !== id));
    } else {
      onChange(selectedRouterIds, [...selectedGroupIds, id]);
    }
  };

  return (
    <div className="space-y-4 border border-white/10 rounded-md p-4 bg-card/40">
      <div className="relative">
        <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
        <Input 
          placeholder="Search devices or groups..." 
          className="pl-9" 
          value={search}
          onChange={e => setSearch(e.target.value)}
        />
      </div>

      <div className="grid grid-cols-2 gap-4 h-[300px]">
        <div className="flex flex-col border border-white/5 rounded-md bg-black/20 overflow-hidden">
          <div className="px-3 py-2 bg-black/40 border-b border-white/5 text-xs font-medium text-muted-foreground flex justify-between">
            <span>Groups</span>
            <span>{selectedGroupIds.length} selected</span>
          </div>
          <div className="flex-1 overflow-y-auto">
            <div className="p-2 space-y-1">
              {filteredGroups.length === 0 && <div className="p-2 text-center text-xs text-muted-foreground">No groups found</div>}
              {filteredGroups.map((g: any) => (
                <label key={g.id} className="flex items-center gap-3 px-2 py-1.5 hover:bg-white/5 rounded cursor-pointer transition-colors">
                  <Checkbox 
                    checked={selectedGroupIds.includes(g.id)} 
                    onCheckedChange={() => toggleGroup(g.id)}
                  />
                  <Folder className="w-4 h-4 text-primary/70 shrink-0" />
                  <span className="text-sm truncate">{g.name}</span>
                </label>
              ))}
            </div>
          </div>
        </div>

        <div className="flex flex-col border border-white/5 rounded-md bg-black/20 overflow-hidden">
          <div className="px-3 py-2 bg-black/40 border-b border-white/5 text-xs font-medium text-muted-foreground flex justify-between">
            <span>Devices</span>
            <span>{selectedRouterIds.length} selected</span>
          </div>
          <div className="flex-1 overflow-y-auto">
            <div className="p-2 space-y-1">
              {filteredRouters.length === 0 && <div className="p-2 text-center text-xs text-muted-foreground">No devices found</div>}
              {filteredRouters.map((r: any) => (
                <label key={r.id} className="flex items-center gap-3 px-2 py-1.5 hover:bg-white/5 rounded cursor-pointer transition-colors">
                  <Checkbox 
                    checked={selectedRouterIds.includes(r.id)} 
                    onCheckedChange={() => toggleRouter(r.id)}
                  />
                  <Server className="w-4 h-4 text-primary/70 shrink-0" />
                  <div className="flex flex-col truncate">
                    <span className="text-sm truncate">{r.name}</span>
                    <span className="text-[10px] text-muted-foreground font-mono truncate">{r.ipAddress}</span>
                  </div>
                </label>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
