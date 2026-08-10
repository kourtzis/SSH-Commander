// ─── Config normalization + diffing ─────────────────────────────────
// Pure logic (no DB imports — unit-testable): cleaning raw SSH capture
// into a presentable export, normalizing for comparison, hashing, and
// computing drift diffs.

import crypto from "crypto";
import { structuredPatch, createTwoFilesPatch } from "diff";

// Local ANSI stripper — deliberately not imported from ssh.ts so this
// module stays free of the ssh2 dependency chain.
function stripAnsiLocal(s: string): string {
  return s
    .replace(/\x1b\[[\d;?]*[a-zA-Z]/g, "") // CSI sequences
    .replace(/\x1b[()][A-Za-z0-9]/g, "")   // charset selectors
    .replace(/\x1b./g, "")                  // bare ESC + char
    .replace(/\r/g, "");
}

// Trailing CLI prompt lines like "[admin@MikroTik] >" or "Router#"
const PROMPT_LINE_RE = /^(\[[^\]]*\]\s*[>#]?|\S+[>#])\s*$/;

/**
 * Clean a raw SSH capture of a config export for storage/display:
 * strip ANSI, drop the echoed command line and trailing prompt lines,
 * trim trailing whitespace, collapse runs of blank lines.
 */
export function cleanDeviceExport(raw: string): string {
  const lines = stripAnsiLocal(raw).split("\n").map((l) => l.replace(/\s+$/, ""));

  // Drop leading lines up to and including the echoed command (/export or
  // show running-config). Devices echo the command before the output.
  let start = 0;
  for (let i = 0; i < Math.min(lines.length, 10); i++) {
    if (/^\s*(\/export\b|show\s+running-config\b)/i.test(lines[i])) {
      start = i + 1;
      break;
    }
  }

  // Drop trailing prompt/blank lines.
  let end = lines.length;
  while (end > start) {
    const l = lines[end - 1].trim();
    if (l === "" || PROMPT_LINE_RE.test(l)) end--;
    else break;
  }

  const body = lines.slice(start, end);

  // Collapse 3+ consecutive blank lines into one.
  const out: string[] = [];
  let blanks = 0;
  for (const l of body) {
    if (l.trim() === "") {
      blanks++;
      if (blanks > 1) continue;
    } else {
      blanks = 0;
    }
    out.push(l);
  }
  return out.join("\n").trim();
}

// Volatile header comments RouterOS bakes into every /export — they change
// on every capture (timestamp) or identify the specific unit (serial),
// so they must never count as drift or break dedup.
const VOLATILE_COMMENT_RE = /^#.*(by RouterOS|software id|serial number|model =|^#\s*\d{4}[-/]\d{2}[-/]\d{2})/i;

/**
 * Normalize a cleaned export for comparison: drop volatile comments and
 * lines matching any caller-supplied ignore pattern (invalid regexes are
 * skipped rather than throwing — a bad pattern must not kill a check).
 */
export function normalizeForCompare(cleaned: string, ignorePatterns: string[] = []): string {
  const regexes: RegExp[] = [];
  for (const p of ignorePatterns) {
    if (!p || !p.trim()) continue;
    try {
      regexes.push(new RegExp(p));
    } catch {
      // invalid user regex — ignore the pattern, not the check
    }
  }
  const kept = cleaned
    .split("\n")
    .map((l) => l.replace(/\s+$/, ""))
    .filter((l) => {
      if (VOLATILE_COMMENT_RE.test(l.trim())) return false;
      for (const re of regexes) {
        if (re.test(l)) return false;
      }
      return true;
    });
  return kept.join("\n").trim();
}

export function hashConfig(normalized: string): string {
  return crypto.createHash("sha256").update(normalized).digest("hex");
}

export interface ConfigDiffResult {
  inSync: boolean;
  addedLines: number;   // present in `actual`, missing from `expected`
  removedLines: number; // present in `expected`, missing from `actual`
  diff: string;         // unified diff, "" when in sync
}

/**
 * Diff two normalized configs (expected = golden baseline, actual = device).
 */
export function computeConfigDiff(
  expected: string,
  actual: string,
  labels: { expected: string; actual: string } = { expected: "golden config", actual: "device export" },
): ConfigDiffResult {
  if (expected === actual) {
    return { inSync: true, addedLines: 0, removedLines: 0, diff: "" };
  }
  const patch = structuredPatch(labels.expected, labels.actual, expected + "\n", actual + "\n", "", "", { context: 3 });
  let added = 0;
  let removed = 0;
  for (const hunk of patch.hunks) {
    for (const line of hunk.lines) {
      if (line.startsWith("+")) added++;
      else if (line.startsWith("-")) removed++;
    }
  }
  if (added === 0 && removed === 0) {
    // Only whitespace/context differences survived — treat as in sync.
    return { inSync: true, addedLines: 0, removedLines: 0, diff: "" };
  }
  const diff = createTwoFilesPatch(labels.expected, labels.actual, expected + "\n", actual + "\n", "", "", { context: 3 });
  return { inSync: false, addedLines: added, removedLines: removed, diff };
}
