import React from 'react';
import { extractTags } from '@/lib/utils';

const TAG_REGEX = /(\{\{[A-Z0-9_]+\}\})/;
const CTRL_CHAR_REGEX = /(<<[A-Z+\\\[\]]+>>)/;
const COMBINED_REGEX = /(\{\{[A-Z0-9_]+\}\}|<<[A-Z+\\\[\]]+>>)/g;

export function SnippetViewer({ code }: { code: string }) {
  if (!code) return null;

  const parts = code.split(COMBINED_REGEX);

  return (
    <pre className="font-mono text-sm bg-black/40 p-4 rounded-xl border border-white/5 overflow-x-auto whitespace-pre-wrap">
      <code>
        {parts.map((part, i) => {
          if (TAG_REGEX.test(part)) {
            return (
              <span key={i} className="tag-highlight mx-0.5">
                {part}
              </span>
            );
          }
          if (CTRL_CHAR_REGEX.test(part)) {
            return (
              <span key={i} className="inline-block bg-orange-500/20 text-orange-400 border border-orange-500/30 rounded px-1 mx-0.5 text-xs font-bold">
                {part}
              </span>
            );
          }
          return <span key={i} className="text-muted-foreground">{part}</span>;
        })}
      </code>
    </pre>
  );
}
