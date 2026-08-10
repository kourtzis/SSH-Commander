import React from "react";

interface DiffViewerProps {
  diff: string;
  className?: string;
}

export function DiffViewer({ diff, className = "" }: DiffViewerProps) {
  if (!diff) {
    return (
      <div className={`p-8 text-center text-muted-foreground italic border border-white/10 rounded-md bg-black/40 ${className}`}>
        No differences found.
      </div>
    );
  }

  const lines = diff.split("\n");

  return (
    <div className={`overflow-y-auto border border-white/10 rounded-md bg-black/60 font-mono text-sm ${className}`}>
      <div className="p-4 w-full inline-block min-w-max">
        {lines.map((line, i) => {
          let lineClass = "text-muted-foreground/80";
          let bgClass = "transparent";

          if (line.startsWith("+") && !line.startsWith("+++")) {
            lineClass = "text-emerald-400";
            bgClass = "bg-emerald-500/10";
          } else if (line.startsWith("-") && !line.startsWith("---")) {
            lineClass = "text-destructive";
            bgClass = "bg-destructive/10";
          } else if (line.startsWith("@@")) {
            lineClass = "text-primary/70 font-semibold";
            bgClass = "bg-primary/5";
          } else if (line.startsWith("+++") || line.startsWith("---")) {
            lineClass = "text-foreground font-semibold";
          }

          return (
            <div key={i} className={`px-2 py-0.5 whitespace-pre ${bgClass}`}>
              <span className={lineClass}>{line}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
