import React from 'react';
import { extractTags } from '@/lib/utils';

export function SnippetViewer({ code }: { code: string }) {
  // Simple rendering of code with {{TAGS}} highlighted
  if (!code) return null;

  const regex = /(\{\{[A-Z0-9_]+\}\})/g;
  const parts = code.split(regex);

  return (
    <pre className="font-mono text-sm bg-black/40 p-4 rounded-xl border border-white/5 overflow-x-auto whitespace-pre-wrap">
      <code>
        {parts.map((part, i) => {
          if (part.match(regex)) {
            return (
              <span key={i} className="tag-highlight mx-0.5">
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
