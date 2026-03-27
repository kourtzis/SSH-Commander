import React, { useState, useRef, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Terminal } from "lucide-react";

const CONTROL_CHARS = [
  { label: "Ctrl+C", tag: "<<CTRL+C>>", desc: "Interrupt / cancel" },
  { label: "Ctrl+Z", tag: "<<CTRL+Z>>", desc: "Suspend / EOF" },
  { label: "Ctrl+D", tag: "<<CTRL+D>>", desc: "End of input" },
  { label: "Tab", tag: "<<TAB>>", desc: "Tab / autocomplete" },
  { label: "Enter", tag: "<<ENTER>>", desc: "Carriage return" },
  { label: "Esc", tag: "<<ESC>>", desc: "Escape" },
  { label: "Backspace", tag: "<<BACKSPACE>>", desc: "Delete backward" },
  { label: "Del", tag: "<<DEL>>", desc: "Delete forward" },
  { label: "Ctrl+A", tag: "<<CTRL+A>>", desc: "Beginning of line" },
  { label: "Ctrl+E", tag: "<<CTRL+E>>", desc: "End of line" },
  { label: "Ctrl+K", tag: "<<CTRL+K>>", desc: "Kill to end of line" },
  { label: "Ctrl+U", tag: "<<CTRL+U>>", desc: "Kill to start of line" },
  { label: "Ctrl+W", tag: "<<CTRL+W>>", desc: "Delete previous word" },
  { label: "Ctrl+L", tag: "<<CTRL+L>>", desc: "Clear screen" },
  { label: "Ctrl+R", tag: "<<CTRL+R>>", desc: "Reverse search" },
];

interface ControlCharInsertProps {
  onInsert: (tag: string) => void;
}

export function ControlCharInsert({ onInsert }: ControlCharInsertProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  return (
    <div className="relative" ref={ref}>
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => setOpen(!open)}
        className="h-7 px-2 text-xs gap-1"
      >
        <Terminal className="w-3 h-3" />
        Ctrl Char
      </Button>
      {open && (
        <div className="absolute z-50 top-full mt-1 right-0 w-64 max-h-72 overflow-y-auto bg-background border border-white/10 rounded-lg shadow-xl p-1">
          {CONTROL_CHARS.map((c) => (
            <button
              key={c.tag}
              type="button"
              className="w-full text-left px-3 py-1.5 rounded text-sm hover:bg-white/10 flex items-center gap-3 transition-colors"
              onClick={() => {
                onInsert(c.tag);
                setOpen(false);
              }}
            >
              <code className="text-xs text-primary font-mono bg-primary/10 px-1.5 py-0.5 rounded min-w-[70px] text-center">{c.label}</code>
              <span className="text-muted-foreground text-xs">{c.desc}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
