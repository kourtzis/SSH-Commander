import { useState, useCallback, useMemo } from "react";

export function useSelection<T extends number | string>(allIds: T[]) {
  const [selected, setSelected] = useState<Set<T>>(new Set());

  const toggle = useCallback((id: T) => {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const toggleAll = useCallback(() => {
    setSelected(prev => {
      if (prev.size === allIds.length && allIds.length > 0) return new Set();
      return new Set(allIds);
    });
  }, [allIds]);

  const clear = useCallback(() => setSelected(new Set()), []);

  const isAllSelected = allIds.length > 0 && selected.size === allIds.length;
  const isSomeSelected = selected.size > 0 && selected.size < allIds.length;
  const count = selected.size;
  const ids = useMemo(() => Array.from(selected), [selected]);

  return { selected, toggle, toggleAll, clear, isAllSelected, isSomeSelected, count, ids };
}
