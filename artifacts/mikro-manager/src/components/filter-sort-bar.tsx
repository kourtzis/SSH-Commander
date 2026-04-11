import { useState, useEffect, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Search, SlidersHorizontal, ArrowUpDown, ArrowUp, ArrowDown, X } from "lucide-react";

export interface FilterOption {
  key: string;
  label: string;
  type: "text" | "select" | "tags";
  options?: { value: string; label: string }[];
  allTags?: string[];
}

export interface SortOption {
  key: string;
  label: string;
}

export interface ActiveSort {
  key: string;
  dir: "asc" | "desc";
}

interface FilterSortBarProps {
  searchValue: string;
  onSearchChange: (value: string) => void;
  searchPlaceholder?: string;
  filters?: FilterOption[];
  activeFilters?: Record<string, string | string[]>;
  onFilterChange?: (key: string, value: string | string[]) => void;
  sortOptions?: SortOption[];
  activeSort?: ActiveSort;
  onSortChange?: (sort: ActiveSort) => void;
}

export function FilterSortBar({
  searchValue,
  onSearchChange,
  searchPlaceholder = "Search...",
  filters = [],
  activeFilters = {},
  onFilterChange,
  sortOptions = [],
  activeSort,
  onSortChange,
}: FilterSortBarProps) {
  const [showFilters, setShowFilters] = useState(false);
  const [localSearch, setLocalSearch] = useState(searchValue);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>();

  useEffect(() => {
    setLocalSearch(searchValue);
  }, [searchValue]);

  const handleSearchChange = (value: string) => {
    setLocalSearch(value);
    clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => onSearchChange(value), 200);
  };

  useEffect(() => {
    return () => clearTimeout(debounceRef.current);
  }, []);

  const hasActiveFilters = Object.values(activeFilters).some(v =>
    Array.isArray(v) ? v.length > 0 : v !== ""
  );

  const activeFilterCount = Object.values(activeFilters).filter(v =>
    Array.isArray(v) ? v.length > 0 : v !== ""
  ).length;

  const toggleSort = (key: string) => {
    if (!onSortChange) return;
    if (activeSort?.key === key) {
      onSortChange({ key, dir: activeSort.dir === "asc" ? "desc" : "asc" });
    } else {
      onSortChange({ key, dir: "asc" });
    }
  };

  const clearFilters = () => {
    filters.forEach(f => {
      if (onFilterChange) {
        onFilterChange(f.key, f.type === "tags" ? [] : "");
      }
    });
  };

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 flex-wrap">
        <div className="relative flex-1 min-w-[200px] max-w-md">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <Input
            placeholder={searchPlaceholder}
            value={localSearch}
            onChange={(e) => handleSearchChange(e.target.value)}
            className="pl-9 bg-card border-border/50 shadow-sm"
          />
        </div>

        {filters.length > 0 && (
          <Button
            variant={showFilters ? "secondary" : "outline"}
            size="sm"
            className="h-9 gap-1.5"
            onClick={() => setShowFilters(!showFilters)}
          >
            <SlidersHorizontal className="w-4 h-4" />
            Filters
            {activeFilterCount > 0 && (
              <Badge variant="default" className="ml-1 h-5 w-5 p-0 flex items-center justify-center text-[10px] rounded-full">
                {activeFilterCount}
              </Badge>
            )}
          </Button>
        )}

        {sortOptions.length > 0 && (
          <div className="flex items-center gap-1">
            <span className="text-xs text-muted-foreground mr-1">Sort:</span>
            {sortOptions.map(opt => {
              const isActive = activeSort?.key === opt.key;
              return (
                <Button
                  key={opt.key}
                  variant={isActive ? "secondary" : "ghost"}
                  size="sm"
                  className={`h-7 text-xs gap-1 px-2 ${isActive ? "text-primary" : ""}`}
                  onClick={() => toggleSort(opt.key)}
                >
                  {opt.label}
                  {isActive && (
                    activeSort?.dir === "asc"
                      ? <ArrowUp className="w-3 h-3" />
                      : <ArrowDown className="w-3 h-3" />
                  )}
                  {!isActive && <ArrowUpDown className="w-3 h-3 opacity-40" />}
                </Button>
              );
            })}
          </div>
        )}
      </div>

      {showFilters && filters.length > 0 && (
        <div className="flex items-end gap-3 flex-wrap p-3 rounded-xl border border-white/5 bg-black/20 animate-in fade-in slide-in-from-top-1 duration-150">
          {filters.map(f => (
            <div key={f.key} className="space-y-1">
              <label className="text-xs text-muted-foreground font-medium">{f.label}</label>
              {f.type === "select" && f.options && (
                <select
                  className="h-8 text-xs rounded-lg border border-input bg-background/50 px-2 focus:outline-none focus:ring-1 focus:ring-primary/50 min-w-[120px]"
                  value={(activeFilters[f.key] as string) || ""}
                  onChange={(e) => onFilterChange?.(f.key, e.target.value)}
                >
                  <option value="">All</option>
                  {f.options.map(o => (
                    <option key={o.value} value={o.value}>{o.label}</option>
                  ))}
                </select>
              )}
              {f.type === "tags" && f.allTags && (
                <div className="flex flex-wrap gap-1">
                  {f.allTags.map(tag => {
                    const selected = ((activeFilters[f.key] as string[]) || []).includes(tag);
                    return (
                      <button
                        key={tag}
                        onClick={() => {
                          const current = (activeFilters[f.key] as string[]) || [];
                          onFilterChange?.(
                            f.key,
                            selected ? current.filter(t => t !== tag) : [...current, tag]
                          );
                        }}
                        className={`text-xs px-2 py-0.5 rounded-full border transition-colors ${
                          selected
                            ? "bg-primary/20 border-primary/40 text-primary"
                            : "border-white/10 text-muted-foreground hover:border-white/20"
                        }`}
                      >
                        {tag}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          ))}
          {hasActiveFilters && (
            <Button variant="ghost" size="sm" className="h-8 text-xs gap-1 text-muted-foreground" onClick={clearFilters}>
              <X className="w-3 h-3" /> Clear
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

export function applySort<T>(items: T[], sort: ActiveSort | undefined, getters: Record<string, (item: T) => any>): T[] {
  if (!sort || !getters[sort.key]) return items;
  const getter = getters[sort.key];
  return [...items].sort((a, b) => {
    const va = getter(a);
    const vb = getter(b);
    let cmp = 0;
    if (typeof va === "string" && typeof vb === "string") {
      cmp = va.localeCompare(vb, undefined, { sensitivity: "base" });
    } else if (va instanceof Date && vb instanceof Date) {
      cmp = va.getTime() - vb.getTime();
    } else if (typeof va === "number" && typeof vb === "number") {
      cmp = va - vb;
    } else {
      cmp = String(va).localeCompare(String(vb));
    }
    return sort.dir === "desc" ? -cmp : cmp;
  });
}
