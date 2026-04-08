import { useRef, useCallback } from "react";

export function useDragReorder<T>(items: T[], setItems: (items: T[]) => void) {
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
