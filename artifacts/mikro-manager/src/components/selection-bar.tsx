import { Button } from "@/components/ui/button";
import { Trash2, X } from "lucide-react";

interface SelectionBarProps {
  count: number;
  label?: string;
  onDelete: () => void;
  onClear: () => void;
  isDeleting?: boolean;
}

export function SelectionBar({ count, label = "items", onDelete, onClear, isDeleting }: SelectionBarProps) {
  if (count === 0) return null;

  return (
    <div className="sticky top-0 z-20 flex items-center justify-between gap-4 px-4 py-2.5 rounded-xl bg-primary/10 border border-primary/30 backdrop-blur-sm mb-4">
      <span className="text-sm font-medium text-primary">
        {count} {count === 1 ? label.replace(/s$/, "") : label} selected
      </span>
      <div className="flex items-center gap-2">
        <Button
          size="sm"
          variant="destructive"
          className="gap-1.5 h-8"
          onClick={onDelete}
          disabled={isDeleting}
        >
          <Trash2 className="w-3.5 h-3.5" />
          {isDeleting ? "Deleting..." : "Delete"}
        </Button>
        <Button size="sm" variant="ghost" className="h-8 px-2" onClick={onClear}>
          <X className="w-4 h-4" />
        </Button>
      </div>
    </div>
  );
}
