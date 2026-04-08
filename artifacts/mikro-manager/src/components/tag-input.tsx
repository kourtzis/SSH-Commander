import { useState, useRef, useEffect } from "react";
import { Badge } from "@/components/ui/badge";
import { X } from "lucide-react";

interface TagInputProps {
  tags: string[];
  onChange: (tags: string[]) => void;
  allTags: string[];
  placeholder?: string;
}

export function TagInput({ tags, onChange, allTags, placeholder = "Type a tag..." }: TagInputProps) {
  const [input, setInput] = useState("");
  const [isOpen, setIsOpen] = useState(false);
  const [highlightIdx, setHighlightIdx] = useState(-1);
  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const unusedTags = allTags.filter(t => !tags.includes(t));
  const suggestions = input.trim()
    ? unusedTags.filter(t => t.toLowerCase().includes(input.toLowerCase()))
    : unusedTags;

  const addTag = (tag: string) => {
    const trimmed = tag.trim();
    if (!trimmed) return;
    if (tags.includes(trimmed)) return;
    onChange([...tags, trimmed]);
    setInput("");
    setHighlightIdx(-1);
    inputRef.current?.focus();
  };

  const removeTag = (tag: string) => {
    onChange(tags.filter(t => t !== tag));
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" || e.key === "Tab") {
      e.preventDefault();
      if (highlightIdx >= 0 && highlightIdx < suggestions.length) {
        addTag(suggestions[highlightIdx]);
      } else if (input.trim()) {
        addTag(input);
      }
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setHighlightIdx(prev => Math.min(prev + 1, suggestions.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlightIdx(prev => Math.max(prev - 1, 0));
    } else if (e.key === "Escape") {
      setIsOpen(false);
      setHighlightIdx(-1);
    } else if (e.key === "Backspace" && !input && tags.length > 0) {
      onChange(tags.slice(0, -1));
    }
  };

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  useEffect(() => {
    setHighlightIdx(-1);
  }, [input]);

  return (
    <div className="space-y-1.5">
      <div ref={containerRef} className="relative">
        <div
          className="flex flex-wrap items-center gap-1.5 min-h-[40px] rounded-xl border border-input bg-background/50 px-3 py-1.5 cursor-text focus-within:ring-2 focus-within:ring-primary/50"
          onClick={() => inputRef.current?.focus()}
        >
          {tags.map(tag => (
            <Badge
              key={tag}
              variant="secondary"
              className="bg-primary/10 text-primary gap-1 pl-2 pr-1 py-0.5 text-xs"
            >
              {tag}
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); removeTag(tag); }}
                className="hover:bg-primary/20 rounded-full p-0.5 transition-colors"
              >
                <X className="w-3 h-3" />
              </button>
            </Badge>
          ))}
          <input
            ref={inputRef}
            type="text"
            value={input}
            onChange={(e) => { setInput(e.target.value); setIsOpen(true); }}
            onFocus={() => setIsOpen(true)}
            onKeyDown={handleKeyDown}
            placeholder={tags.length === 0 ? placeholder : ""}
            className="flex-1 min-w-[80px] bg-transparent text-sm outline-none placeholder:text-muted-foreground"
          />
        </div>

        {isOpen && suggestions.length > 0 && (
          <div className="absolute z-50 w-full mt-1 max-h-40 overflow-y-auto rounded-xl border border-white/10 bg-popover shadow-lg animate-in fade-in zoom-in-95 duration-100">
            {suggestions.map((tag, idx) => (
              <button
                key={tag}
                type="button"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => { addTag(tag); setIsOpen(true); }}
                onMouseEnter={() => setHighlightIdx(idx)}
                className={`w-full text-left px-3 py-2 text-sm transition-colors ${
                  idx === highlightIdx
                    ? "bg-primary/10 text-primary"
                    : "hover:bg-white/5"
                }`}
              >
                {input.trim() ? highlightMatch(tag, input) : tag}
              </button>
            ))}
          </div>
        )}
      </div>
      <p className="text-xs text-muted-foreground">
        Type and press Enter or Tab to add a tag. Select from suggestions or create new ones.
      </p>
    </div>
  );
}

function highlightMatch(text: string, query: string) {
  const lower = text.toLowerCase();
  const idx = lower.indexOf(query.toLowerCase());
  if (idx === -1) return text;
  return (
    <>
      {text.slice(0, idx)}
      <span className="font-semibold text-primary">{text.slice(idx, idx + query.length)}</span>
      {text.slice(idx + query.length)}
    </>
  );
}
