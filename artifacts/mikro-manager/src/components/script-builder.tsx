import { useState, useRef } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { SnippetViewer } from "@/components/snippet-viewer";
import { ControlCharInsert } from "@/components/control-char-insert";
import { useDragReorder } from "@/hooks/use-drag-reorder";
import { extractTags } from "@/lib/utils";
import { GripVertical, X, FileCode, Code2, Plus, ChevronDown, ChevronUp, Eye } from "lucide-react";

export interface ScriptBlock {
  instanceId: string;
  type: "snippet" | "code";
  snippetId?: number;
  snippetName?: string;
  snippetTags?: string[];
  code: string;
}

interface SnippetOption {
  id: number;
  name: string;
  tags: string[];
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
  const [dragOverIdx, setDragOverIdx] = useState<number | null>(null);
  const [draggingIdx, setDraggingIdx] = useState<number | null>(null);
  const [previewOpen, setPreviewOpen] = useState(false);
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
      snippetTags: snippet.tags,
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

  const handleDragStart = (idx: number) => {
    setDraggingIdx(idx);
    drag.onDragStart(idx);
  };

  const handleDragOver = (e: React.DragEvent, idx: number) => {
    setDragOverIdx(idx);
    drag.onDragOver(e, idx);
  };

  const handleDrop = () => {
    drag.onDrop();
    setDragOverIdx(null);
    setDraggingIdx(null);
  };

  const handleDragEnd = () => {
    setDragOverIdx(null);
    setDraggingIdx(null);
  };

  const combined = buildCombinedScript(blocks);
  const tags = extractTags(combined);

  const renderInsertBar = (atIndex: number) => {
    const isOpen = insertIndex === atIndex;
    return (
      <div className="flex items-center gap-1 py-1 group/insert">
        <div className="flex-1 h-px bg-white/15 group-hover/insert:bg-primary/40 transition-colors" />
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
                  <option key={s.id} value={s.id}>{s.name} ({(s.tags || []).join(", ") || "no tags"})</option>
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
            className="h-6 w-6 p-0 rounded-full opacity-40 group-hover/insert:opacity-100 transition-opacity text-muted-foreground hover:text-primary border border-white/10 group-hover/insert:border-primary/40"
            onClick={() => setInsertIndex(atIndex)}
            title="Insert block here"
          >
            <Plus className="w-3.5 h-3.5" />
          </Button>
        )}
        <div className="flex-1 h-px bg-white/15 group-hover/insert:bg-primary/40 transition-colors" />
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

        {blocks.map((block, idx) => {
          const isDragging = draggingIdx === idx;
          const isDragOver = dragOverIdx === idx && draggingIdx !== idx;

          return (
            <div key={block.instanceId}>
              <div
                draggable
                onDragStart={() => handleDragStart(idx)}
                onDragOver={(e) => handleDragOver(e, idx)}
                onDrop={handleDrop}
                onDragEnd={handleDragEnd}
                className={`flex flex-col rounded-lg border transition-all duration-150 ${
                  isDragging
                    ? "opacity-40 scale-[0.98] border-primary/40 bg-primary/5"
                    : isDragOver
                    ? "border-primary/60 bg-primary/10 shadow-[0_0_12px_rgba(45,212,191,0.15)]"
                    : "bg-black/30 border-white/5 hover:border-white/15"
                }`}
              >
                <div className="flex items-center gap-0">
                  <div
                    className={`flex items-center justify-center w-10 shrink-0 self-stretch rounded-l-lg cursor-grab active:cursor-grabbing transition-colors ${
                      isDragOver
                        ? "bg-primary/20"
                        : "bg-white/[0.03] hover:bg-white/[0.07]"
                    }`}
                    title="Drag to reorder"
                  >
                    <div className="flex flex-col items-center gap-[3px]">
                      <div className="flex gap-[3px]">
                        <span className={`w-[3px] h-[3px] rounded-full transition-colors ${isDragOver ? "bg-primary" : "bg-muted-foreground/40"}`} />
                        <span className={`w-[3px] h-[3px] rounded-full transition-colors ${isDragOver ? "bg-primary" : "bg-muted-foreground/40"}`} />
                      </div>
                      <div className="flex gap-[3px]">
                        <span className={`w-[3px] h-[3px] rounded-full transition-colors ${isDragOver ? "bg-primary" : "bg-muted-foreground/40"}`} />
                        <span className={`w-[3px] h-[3px] rounded-full transition-colors ${isDragOver ? "bg-primary" : "bg-muted-foreground/40"}`} />
                      </div>
                      <div className="flex gap-[3px]">
                        <span className={`w-[3px] h-[3px] rounded-full transition-colors ${isDragOver ? "bg-primary" : "bg-muted-foreground/40"}`} />
                        <span className={`w-[3px] h-[3px] rounded-full transition-colors ${isDragOver ? "bg-primary" : "bg-muted-foreground/40"}`} />
                      </div>
                    </div>
                  </div>

                  <div className="flex items-center gap-2 p-2.5 flex-1 min-w-0">
                    <span className="text-xs text-muted-foreground font-mono w-5 shrink-0">{idx + 1}.</span>

                    {block.type === "snippet" ? (
                      <>
                        <FileCode className="w-4 h-4 text-primary shrink-0" />
                        <span className="text-sm font-medium flex-1 truncate">{block.snippetName}</span>
                        <Badge variant="outline" className="text-xs border-white/10 shrink-0">{(block.snippetTags || []).join(", ") || "no tags"}</Badge>
                      </>
                    ) : (
                      <>
                        <Code2 className="w-4 h-4 text-orange-400 shrink-0" />
                        <span className="text-sm font-medium flex-1 truncate text-orange-400/80">Custom Code</span>
                        <ControlCharInsert onInsert={(tag) => handleInsertCtrlChar(block.instanceId, tag)} />
                      </>
                    )}

                    <button
                      onClick={() => toggleExpand(block.instanceId)}
                      className="text-muted-foreground hover:text-foreground transition-colors shrink-0 p-0.5"
                      title={expandedCode.has(block.instanceId) ? "Collapse" : "Expand"}
                    >
                      {expandedCode.has(block.instanceId) ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
                    </button>

                    <button
                      onClick={() => removeBlock(block.instanceId)}
                      className="text-muted-foreground hover:text-destructive transition-colors shrink-0 p-0.5"
                    >
                      <X className="w-4 h-4" />
                    </button>
                  </div>
                </div>

                {block.type === "snippet" && expandedCode.has(block.instanceId) && (
                  <div className="px-3 pb-3 ml-10">
                    <div className="max-h-32 overflow-y-auto rounded-lg">
                      <SnippetViewer code={block.code} />
                    </div>
                  </div>
                )}

                {block.type === "code" && expandedCode.has(block.instanceId) && (
                  <div className="px-3 pb-3 ml-10">
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
          );
        })}
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
              <option key={s.id} value={s.id}>{s.name} ({(s.tags || []).join(", ") || "no tags"})</option>
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

      {combined && (
        <div className="border border-white/5 rounded-xl overflow-hidden mt-2">
          <button
            onClick={() => setPreviewOpen(prev => !prev)}
            className="w-full flex items-center justify-between px-4 py-2.5 bg-black/20 hover:bg-white/[0.03] transition-colors text-left"
          >
            <div className="flex items-center gap-2">
              <Eye className="w-4 h-4 text-primary" />
              <span className="text-sm font-medium">Final Script Preview</span>
              <span className="text-xs text-muted-foreground">
                ({blocks.filter(b => b.code.trim()).length} block{blocks.filter(b => b.code.trim()).length !== 1 ? "s" : ""}, {combined.split("\n").length} line{combined.split("\n").length !== 1 ? "s" : ""})
              </span>
            </div>
            {previewOpen ? <ChevronUp className="w-4 h-4 text-muted-foreground" /> : <ChevronDown className="w-4 h-4 text-muted-foreground" />}
          </button>
          {previewOpen && (
            <div className="max-h-64 overflow-y-auto border-t border-white/5">
              <SnippetViewer code={combined} />
            </div>
          )}
        </div>
      )}
    </div>
  );
}
