import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { APP_VERSION, CHANGELOG, type ChangelogEntry } from "@/lib/version";
import { FileText } from "lucide-react";
import { cn } from "@/lib/utils";

const sectionColors: Record<string, string> = {
  Added: "bg-emerald-500/20 text-emerald-400 border-emerald-500/30",
  Improved: "bg-blue-500/20 text-blue-400 border-blue-500/30",
  Optimized: "bg-violet-500/20 text-violet-400 border-violet-500/30",
  Fixed: "bg-amber-500/20 text-amber-400 border-amber-500/30",
  Security: "bg-red-500/20 text-red-400 border-red-500/30",
};

function VersionEntry({ entry, isCurrent }: { entry: ChangelogEntry; isCurrent: boolean }) {
  return (
    <div className={cn("rounded-xl border p-4", isCurrent ? "border-primary/30 bg-primary/5" : "border-white/5 bg-white/[0.02]")}>
      <div className="flex items-center gap-2 mb-3">
        <span className="font-mono font-semibold text-sm">{entry.version}</span>
        <span className="text-xs text-muted-foreground">{entry.date}</span>
        {isCurrent && (
          <Badge variant="outline" className="text-[10px] px-1.5 py-0 border-primary/40 text-primary">
            current
          </Badge>
        )}
      </div>
      <div className="space-y-3">
        {entry.sections.map((section) => (
          <div key={section.title}>
            <Badge
              variant="outline"
              className={cn("text-[10px] px-1.5 py-0 mb-1.5", sectionColors[section.title] || "bg-white/10 text-white/60")}
            >
              {section.title}
            </Badge>
            <ul className="space-y-1 ml-1">
              {section.items.map((item, i) => (
                <li key={i} className="text-xs text-muted-foreground flex gap-2">
                  <span className="text-white/20 mt-0.5 shrink-0">•</span>
                  <span>{item}</span>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </div>
  );
}

interface ChangelogDialogProps {
  children: React.ReactNode;
}

export function ChangelogDialog({ children }: ChangelogDialogProps) {
  const [open, setOpen] = useState(false);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>{children}</DialogTrigger>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FileText className="w-5 h-5 text-primary" />
            Changelog
          </DialogTitle>
          <DialogDescription className="sr-only">
            Version history and release notes for SSH Commander
          </DialogDescription>
        </DialogHeader>
        <div className="max-h-[60vh] overflow-y-auto pr-2 space-y-3">
          {CHANGELOG.map((entry) => (
            <VersionEntry
              key={entry.version}
              entry={entry}
              isCurrent={entry.version === APP_VERSION}
            />
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
