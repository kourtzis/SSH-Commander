import { useState, useRef } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { SnippetViewer } from "@/components/snippet-viewer";
import { ControlCharInsert } from "@/components/control-char-insert";
import { useDragReorder } from "@/hooks/use-drag-reorder";
import { extractTags } from "@/lib/utils";
import { GripVertical, X, FileCode, Code2, Plus, ChevronDown, ChevronUp } from "lucide-react";

export interface ScriptBlock {
  instanceId: string;
  type: "snippet" | "code";
  snippetId?: number;
  snippetName?: string;
  snippetCategory?: string;
  code: string;
}

interface SnippetOption {
  id: number;
  name: string;
  category: string;
  code: string;
}

interface ScriptBuilderProps {
  blocks: ScriptBlock[];
  onChange: (blocks: ScriptBlock[]) => void;
  snippets: SnippetOption[];
  excludeSnippetId?: number;
}

function makeId() {
  return `block-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function buildCombinedScript(blocks: ScriptBlock[]): string {
  return blocks
    .map(b => b.code.trim())
    .filter(Boolean)
    .join("\n\n");
}

export function ScriptBuilder({ blocks, onChange, snippets, excludeSnippetId }: ScriptBuilderProps) {
  const [insertIndex, setInsertIndex] = useState<number | null>(null);
  const [expandedCode, setExpandedCode] = useState<Set<string>>(new Set());
  const textareaRefs = useRef<Record<string, HTMLTextAreaElement | null>>({});

  const drag = useDragReorder(blocks, onChange);

  const availableSnippets = excludeSnippetId
    ? snippets.filter(s => s.id !== excludeSnippetId)
    : snippets;

  const addSnippetBlock = (snippetId: number, atIndex?: number) => {
    const snippet = snippets.find(s => s.id === snippetId);
    if (!snippet) return;
    const block: ScriptBlock = {
      instanceId: makeId(),
      type: "snippet",
      snippetId: snippet.id,
      snippetName: snippet.name,
      snippetCategory: snippet.category,
      code: snippet.code,
    };
    const next = [...blocks];
    const idx = atIndex !== undefined ? atIndex : next.length;
    next.splice(idx, 0, block);
    onChange(next);
    setInsertIndex(null);
  };

  const addCodeBlock = (atIndex?: number) => {
    const block: ScriptBlock = {
      instanceId: makeId(),
      type: "code",
      code: "",
    };
    const next = [...blocks];
    const idx = atIndex !== undefined ? atIndex : next.length;
    next.splice(idx, 0, block);
    onChange(next);
    setInsertIndex(null);
    setExpandedCode(prev => new Set(prev).add(block.instanceId));
  };

  const removeBlock = (instanceId: string) => {
    onChange(blocks.filter(b => b.instanceId !== instanceId));
    setExpandedCode(prev => {
      const next = new Set(prev);
      next.delete(instanceId);
      return next;
    });
  };

  const updateCodeBlock = (instanceId: string, code: string) => {
    onChange(blocks.map(b => b.instanceId === instanceId ? { ...b, code } : b));
  };

  const toggleExpand = (instanceId: string) => {
    setExpandedCode(prev => {
      const next = new Set(prev);
      if (next.has(instanceId)) next.delete(instanceId);
      else next.add(instanceId);
      return next;
    });
  };

  const handleInsertCtrlChar = (instanceId: string, tag: string) => {
    const textarea = textareaRefs.current[instanceId];
    if (textarea) {
      const start = textarea.selectionStart;
      const end = textarea.selectionEnd;
      const current = blocks.find(b => b.instanceId === instanceId)?.code || "";
      const newCode = current.slice(0, start) + tag + current.slice(end);
      updateCodeBlock(instanceId, newCode);
      requestAnimationFrame(() => {
        textarea.focus();
        const pos = start + tag.length;
        textarea.setSelectionRange(pos, pos);
      });
    } else {
      const current = blocks.find(b => b.instanceId === instanceId)?.code || "";
      updateCodeBlock(instanceId, current + tag);
    }
  };

  const combined = buildCombinedScript(blocks);
  const tags = extractTags(combined);

  const renderInsertBar = (atIndex: number) => {
    const isOpen = insertIndex === atIndex;
    return (
      <div className="flex items-center gap-1 py-0.5 group/insert">
        <div className="flex-1 h-px bg-white/5 group-hover/insert:bg-primary/20 transition-colors" />
        {isOpen ? (
          <div className="flex items-center gap-1 animate-in fade-in zoom-in-95 duration-150">
            {availableSnippets.length > 0 && (
              <select
                className="h-7 text-xs rounded-lg border border-input bg-background/80 px-2 focus:outline-none focus:ring-1 focus:ring-primary/50"
                onChange={(e) => {
                  addSnippetBlock(parseInt(e.target.value), atIndex);
                  e.target.value = "";
                }}
                value=""
              >
                <option value="" disabled>+ Snippet</option>
                {availableSnippets.map(s => (
                  <option key={s.id} value={s.id}>{s.name} ({s.category})</option>
                ))}
              </select>
            )}
            <Button
              variant="ghost"
              size="sm"
              className="h-7 text-xs px-2 gap-1"
              onClick={() => addCodeBlock(atIndex)}
            >
              <Code2 className="w-3 h-3" /> Code
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="h-7 w-7 p-0 text-muted-foreground"
              onClick={() => setInsertIndex(null)}
            >
              <X className="w-3 h-3" />
            </Button>
          </div>
        ) : (
          <Button
            variant="ghost"
            size="sm"
            className="h-5 w-5 p-0 rounded-full opacity-0 group-hover/insert:opacity-100 transition-opacity text-muted-foreground hover:text-primary"
            onClick={() => setInsertIndex(atIndex)}
            title="Insert block here"
          >
            <Plus className="w-3 h-3" />
          </Button>
        )}
        <div className="flex-1 h-px bg-white/5 group-hover/insert:bg-primary/20 transition-colors" />
      </div>
    );
  };

  return (
    <div className="space-y-3">
      <div className="flex justify-between items-center">
        <Label className="text-base font-semibold">Script Blocks</Label>
        {tags.length > 0 && (
          <div className="flex gap-1 items-center flex-wrap justify-end">
            <span className="text-xs text-muted-foreground">Variables:</span>
            {tags.map(t => (
              <Badge key={t} variant="outline" className="text-primary border-primary/30 text-xs px-1.5 py-0">{t}</Badge>
            ))}
          </div>
        )}
      </div>

      <div className="space-y-0">
        {renderInsertBar(0)}

        {blocks.map((block, idx) => (
          <div key={block.instanceId}>
            <div
              draggable
              onDragStart={() => drag.onDragStart(idx)}
              onDragOver={(e) => drag.onDragOver(e, idx)}
              onDrop={drag.onDrop}
              className="flex flex-col rounded-lg bg-black/30 border border-white/5 hover:border-primary/30 transition-colors group cursor-grab active:cursor-grabbing"
            >
              <div className="flex items-center gap-2 p-2.5">
                <GripVertical className="w-4 h-4 text-muted-foreground/50 group-hover:text-muted-foreground shrink-0" />
                <span className="text-xs text-muted-foreground font-mono w-5 shrink-0">{idx + 1}.</span>

                {block.type === "snippet" ? (
                  <>
                    <FileCode className="w-4 h-4 text-primary shrink-0" />
                    <span className="text-sm font-medium flex-1 truncate">{block.snippetName}</span>
                    <Badge variant="outline" className="text-xs border-white/10 shrink-0">{block.snippetCategory}</Badge>
                    <button
                      onClick={() => toggleExpand(block.instanceId)}
                      className="text-muted-foreground hover:text-foreground transition-colors shrink-0"
                      title={expandedCode.has(block.instanceId) ? "Collapse" : "Expand"}
                    >
                      {expandedCode.has(block.instanceId) ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
                    </button>
                  </>
                ) : (
                  <>
                    <Code2 className="w-4 h-4 text-orange-400 shrink-0" />
                    <span className="text-sm font-medium flex-1 truncate text-orange-400/80">Custom Code</span>
                    <ControlCharInsert onInsert={(tag) => handleInsertCtrlChar(block.instanceId, tag)} />
                    <button
                      onClick={() => toggleExpand(block.instanceId)}
                      className="text-muted-foreground hover:text-foreground transition-colors shrink-0"
                      title={expandedCode.has(block.instanceId) ? "Collapse" : "Expand"}
                    >
                      {expandedCode.has(block.instanceId) ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
                    </button>
                  </>
                )}

                <button
                  onClick={() => removeBlock(block.instanceId)}
                  className="text-muted-foreground hover:text-destructive transition-colors shrink-0"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>

              {block.type === "snippet" && expandedCode.has(block.instanceId) && (
                <div className="px-3 pb-3">
                  <div className="max-h-32 overflow-y-auto rounded-lg">
                    <SnippetViewer code={block.code} />
                  </div>
                </div>
              )}

              {block.type === "code" && expandedCode.has(block.instanceId) && (
                <div className="px-3 pb-3">
                  <Textarea
                    ref={(el) => { textareaRefs.current[block.instanceId] = el; }}
                    value={block.code}
                    onChange={(e) => updateCodeBlock(block.instanceId, e.target.value)}
                    className="h-32 font-mono text-sm"
                    placeholder="/system identity set name={{HOSTNAME}}"
                    onClick={(e) => e.stopPropagation()}
                    onMouseDown={(e) => e.stopPropagation()}
                  />
                </div>
              )}
            </div>

            {renderInsertBar(idx + 1)}
          </div>
        ))}
      </div>

      <div className="flex items-center gap-2 pt-1">
        {availableSnippets.length > 0 && (
          <select
            className="h-9 flex-1 rounded-xl border border-input bg-background/50 px-3 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
            onChange={(e) => {
              addSnippetBlock(parseInt(e.target.value));
              e.target.value = "";
            }}
            value=""
          >
            <option value="" disabled>Add snippet block...</option>
            {availableSnippets.map(s => (
              <option key={s.id} value={s.id}>{s.name} ({s.category})</option>
            ))}
          </select>
        )}
        <Button
          variant="outline"
          size="sm"
          className="h-9 gap-1.5 shrink-0"
          onClick={() => addCodeBlock()}
        >
          <Code2 className="w-4 h-4" /> Add Code Block
        </Button>
      </div>

      {blocks.length > 1 && combined && (
        <div className="space-y-2 pt-2">
          <Label className="text-muted-foreground">Combined Script Preview</Label>
          <div className="max-h-48 overflow-y-auto rounded-xl">
            <SnippetViewer code={combined} />
          </div>
        </div>
      )}
    </div>
  );
}
