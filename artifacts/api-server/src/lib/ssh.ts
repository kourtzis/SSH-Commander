import { Client } from "ssh2";

// Result returned by executeSSHCommand after an SSH session completes
export interface SSHResult {
  success: boolean;
  output: string;
  errorMessage?: string;
  connectionLog: string;  // Timestamped log of the connection lifecycle
}

// Timestamp helper for connection logs (ISO format without trailing Z)
function ts(): string {
  return new Date().toISOString().replace("T", " ").replace("Z", "");
}

// Hard cap on log size — pathological devices that spew megabytes of output
// (e.g. `show tech-support` on Cisco) would otherwise balloon the
// `batch_jobs.connection_log` JSON column past Postgres TOAST limits and slow
// the job-detail page to a crawl. 4000 lines is plenty for normal scripts and
// still meaningful for debugging when truncated.
const MAX_LOG_LINES = 4000;

// Append wire data (sent or received) to a connection log as one entry per
// line, with a direction prefix (">>" for sent, "<<" for received,
// "<<E" for stderr). Coalesces partial-line chunks via a per-direction buffer
// so a single TCP packet that breaks mid-line is still rendered as full lines.
//
// Why this exists: troubleshooting a job previously meant looking at the
// "Output" pane (raw blob) and the "Connection Log" pane (just metadata) and
// mentally interleaving them with timestamps. The connection log now contains
// the full timeline (handshake → command sent → device replies → prompts →
// close) so an operator can see exactly what was exchanged and when.
//
// Returns the new buffer state — caller must keep the returned string for the
// next chunk so trailing partial lines don't get dropped or duplicated.
export function appendWireLog(
  log: string[],
  buffer: string,
  prefix: string,
  chunk: string,
): string {
  if (!chunk) return buffer;
  // NB: do NOT collapse \r → \n here. \r is a meaningful cursor-to-column-0
  // operation that tidyLine() needs to handle correctly (so cursor-back + CR
  // overwrites on the same line don't get split into two lines).
  const combined = buffer + chunk.replace(/\r\n/g, "\n");
  const parts = combined.split("\n");
  // Last element may be a partial line — keep it as the new buffer.
  const newBuffer = parts.pop() ?? "";
  for (const rawLine of parts) {
    const line = tidyLine(rawLine);
    if (line.length === 0) continue;
    if (log.length >= MAX_LOG_LINES) {
      if (log[log.length - 1] !== "[…connection log truncated]") {
        log.push("[…connection log truncated]");
      }
      return newBuffer;
    }
    log.push(`[${ts()}] ${prefix} ${line}`);
  }
  return newBuffer;
}

// ─── Tidy a single terminal "line" for human display ───────────────
// Real terminal output is a stream of writes mixed with cursor moves and
// line-erase operations. Stripping the escape codes alone gives wrong
// output when a device redraws a line in place — e.g. RouterOS echoes a
// typed command, then sends `\x1b[<N>D` to back up the cursor and
// re-renders the same command with syntax-highlight colors. A flat
// stripper leaves both copies in the log; a real terminal would have
// shown only the second.
//
// tidyLine() emulates a single-line terminal: it processes text writes,
// CR (cursor to col 0), cursor-back (\x1b[<N>D), cursor-forward
// (\x1b[<N>C), and line-erase (\x1b[K / \x1b[1K / \x1b[2K). All other
// CSI sequences (colors, cursor pos to row, etc.) are skipped without
// affecting the line buffer. Other escapes and stray C0/C1 control
// bytes are dropped.
//
// Scope is intentionally per-line — multi-line cursor moves are rare
// in our wire-log use case and would require full terminal emulation
// to handle correctly.
export function tidyLine(input: string): string {
  if (!input) return input;
  let buf: string[] = [];
  let cur = 0;
  const writeChar = (ch: string) => {
    while (buf.length < cur) buf.push(" ");
    buf[cur] = ch;
    cur++;
  };
  let i = 0;
  while (i < input.length) {
    const ch = input[i];
    const code = ch.charCodeAt(0);
    // Carriage return: cursor to column 0 of current line.
    if (ch === "\r") { cur = 0; i++; continue; }
    // ESC [ ... letter — CSI sequence (7-bit form).
    // Also handle 0x9B as single-byte CSI (8-bit form) — devices like
    // RouterOS sometimes emit the C1 form. When the wider stream is
    // decoded as binary/latin1, 0x9B arrives as the same character; if
    // it's been UTF-8-mangled into U+FFFD upstream we won't see it here,
    // which is why the data handlers now use toString("binary").
    const isCsiIntro =
      (ch === "\x1b" && input[i + 1] === "[") ||
      code === 0x9b;
    if (isCsiIntro) {
      let j = ch === "\x1b" ? i + 2 : i + 1;
      let params = "";
      while (j < input.length && /[0-9;?]/.test(input[j])) { params += input[j]; j++; }
      if (j >= input.length) { i = input.length; break; }
      const letter = input[j];
      const n = parseInt(params, 10) || 1;
      if (letter === "D") cur = Math.max(0, cur - n);
      else if (letter === "C") cur = cur + n;
      else if (letter === "K") {
        if (params === "" || params === "0") buf.length = cur;
        else if (params === "1") { for (let k = 0; k < cur && k < buf.length; k++) buf[k] = " "; }
        else if (params === "2") { buf = []; cur = 0; }
      }
      // Any other CSI (m for color, H for pos, n for DSR, etc.) is dropped
      // without affecting the line buffer.
      i = j + 1;
      continue;
    }
    // Other ESC sequences (charset selectors, single-byte etc.): drop ESC
    // and the byte that follows.
    if (ch === "\x1b") { i += 2; continue; }
    // Tab — keep verbatim.
    if (ch === "\t") { writeChar(ch); i++; continue; }
    // C0 controls (other than \t \n \r — \n won't appear because the caller
    // already split on it) and DEL: drop.
    if (code < 0x20 || code === 0x7F) { i++; continue; }
    // C1 controls (0x80–0x9F): drop. These are the "8-bit form" of the
    // ESC-prefixed sequences (e.g. 0x9B is single-byte CSI). We don't
    // try to interpret them as CSI here — devices that use them are rare
    // and the cost of misinterpretation is higher than dropping them.
    if (code >= 0x80 && code <= 0x9f) { i++; continue; }
    writeChar(ch);
    i++;
  }
  // Drop any trailing spaces introduced by cursor jumps that were never
  // overwritten with real characters.
  return buf.join("").replace(/[ \t]+$/, "");
}

// Multi-line tidy: split on real newlines, tidyLine each, rejoin. Use this
// instead of stripAnsi() for any text that's going to be shown to a human
// (job output pane, persisted output, etc.). Also drops leading/trailing
// blank lines and the leading-banner garbage like "DěH" that early-stream
// device-init bytes leave behind once stripAnsi alone has handled them.
export function tidyText(input: string): string {
  if (!input) return "";
  return input
    .split("\n")
    .map(tidyLine)
    .join("\n")
    .replace(/^\s*\n+/, "")   // drop leading blank lines
    .replace(/\n+\s*$/, "");  // drop trailing blank lines
}

// Strip ANSI escape sequences and stray control bytes from terminal output
// before persisting/displaying it. Real-world devices send things like:
//   \x1b[6n            (Device Status Report — terminal queries cursor pos)
//   \x1b[9999B         (move cursor down — used to detect terminal height)
//   \x1b[?2004h        (bracketed paste mode toggle)
//   \x07               (BEL)
//   \x00               (NUL — appears as a box glyph in the UI)
// These are noise to a network operator reading job output. We keep newlines,
// tabs, and carriage returns but drop everything else in C0/C1 + all CSI/OSC
// escape sequences. Applied at output-persist time and at SSE emit time so
// both the saved record and the live stream are clean. The connection log
// (>>/<<) is left raw on purpose — it's the "what actually went over the
// wire" view and stripping it would defeat its diagnostic purpose.
const ANSI_CSI = /(?:\x1b\[|\x9b)[0-9;?]*[ -/]*[@-~]/g;   // CSI: ESC [ ... letter, or 0x9B (8-bit)
const ANSI_OSC = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;    // OSC: ESC ] ... BEL or ST
const ANSI_OTHER = /\x1b[()#][0-9A-Za-z]/g;               // charset selectors
const ANSI_SS = /\x1b[NOPVWXZ\\^_=>]/g;                   // single-shift / misc
const CTRL_CHARS = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F]/g;   // C0+C1 except \t \n \r

export function stripAnsi(text: string): string {
  if (!text) return text;
  return text
    .replace(ANSI_CSI, "")
    .replace(ANSI_OSC, "")
    .replace(ANSI_OTHER, "")
    .replace(ANSI_SS, "")
    .replace(CTRL_CHARS, "");
}

// ─── Stream-aware stripper ──────────────────────────────────────────
// stripAnsi() above is stateless and runs on a single string. Real SSH
// output arrives in TCP-sized chunks and an escape sequence like `\x1b[6n`
// can be split across two chunks (e.g. `\x1b` at the tail of chunk A and
// `[6n` at the head of chunk B). Per-chunk stripping then misses the split
// sequence: chunk A's lone `\x1b` is consumed by the C0/C1 control-char
// rule, chunk B has no `\x1b` to anchor the CSI regex, and `[6n` flows
// through to the UI unmodified — exactly the symptom users were reporting.
//
// stripAnsiStream() solves this by holding back any unterminated trailing
// escape until the next chunk arrives. The pending tail is capped at 64
// chars so a stuck/garbled stream can never grow it without bound.
export type StripState = { pending: string };

export function makeStripState(): StripState {
  return { pending: "" };
}

// Returns true if `s` (which starts at an ESC) contains a complete escape
// sequence — i.e. we know we can hand it off to stripAnsi without losing
// information. Returns false if it looks like a still-arriving sequence
// that should be held back for the next chunk.
function escapeIsComplete(s: string): boolean {
  if (s.length < 2) return false;          // just ESC, definitely incomplete
  const c1 = s.charCodeAt(1);
  // ESC + single byte: charset selector ESC ( B, single-shift ESC N, etc.
  // These are all 2 or 3 char sequences with deterministic length.
  if (s[1] === "[" || s[1] === "]") {
    // CSI / OSC — need a terminator. CSI ends on a byte in 0x40–0x7E (@–~).
    // OSC ends on BEL (0x07) or ST (ESC \).
    if (s[1] === "[") {
      for (let i = 2; i < s.length; i++) {
        const code = s.charCodeAt(i);
        if (code >= 0x40 && code <= 0x7e) return true;
      }
      return false;
    } else {
      for (let i = 2; i < s.length; i++) {
        if (s.charCodeAt(i) === 0x07) return true;
        if (s[i] === "\x1b" && i + 1 < s.length && s[i + 1] === "\\") return true;
      }
      return false;
    }
  }
  if (s[1] === "(" || s[1] === ")" || s[1] === "#") {
    return s.length >= 3;                  // ESC ( B   etc.
  }
  // Single-byte escape (NEL, IND, RI, ...). Already 2 chars, complete.
  // Hex range check matches ANSI_SS regex.
  if ([0x4e, 0x4f, 0x50, 0x56, 0x57, 0x58, 0x5a, 0x5c, 0x5e, 0x5f, 0x3d, 0x3e].includes(c1)) {
    return true;
  }
  // Unknown ESC — assume complete to avoid pinning the stream forever.
  return true;
}

const MAX_PENDING = 64;

export function stripAnsiStream(state: StripState, chunk: string): string {
  if (!chunk) return "";
  const combined = state.pending + chunk;
  // Find the last ESC in the combined buffer. If it's the start of an
  // incomplete sequence, split there: everything before it is safe to
  // strip-and-emit, everything from that ESC onward becomes the new pending.
  let splitAt = combined.length;
  const lastEsc = combined.lastIndexOf("\x1b");
  if (lastEsc !== -1 && !escapeIsComplete(combined.slice(lastEsc))) {
    splitAt = lastEsc;
  }
  const emitPart = combined.slice(0, splitAt);
  let nextPending = combined.slice(splitAt);
  if (nextPending.length > MAX_PENDING) {
    // Stuck — flush whatever we've accumulated rather than buffering forever.
    nextPending = "";
    state.pending = "";
    return stripAnsi(combined);
  }
  state.pending = nextPending;
  return stripAnsi(emitPart);
}

// Drain whatever is left in the strip-state when the stream closes.
// Anything still pending at close time is by definition not going to be
// completed, so flush it through the regular stripper.
export function flushStripState(state: StripState): string {
  if (!state.pending) return "";
  const out = stripAnsi(state.pending);
  state.pending = "";
  return out;
}

// ─── Cursor-position responder (smart DSR) ─────────────────────────
// Some devices (RouterOS most notably) run a terminal-size discovery
// ritual at shell open: send `\x1b[9999B` (cursor down a lot) → DSR
// `\x1b[6n` (where am I?) → `\x1b[H` (home) → DSR → `\x1b[9999C`
// (right) → DSR. The device then deduces rows/cols from the answers.
// A naive "always reply 1;1" responder makes RouterOS think the
// terminal is 1×1, which sends it into a re-probe loop that never
// terminates and never prints the prompt.
//
// makeCursorResponder() returns a function you call from the data
// handler with each chunk. It walks the chunk for cursor-movement
// CSI sequences, maintains a virtual cursor clamped to (rows, cols),
// and replies to any `\x1b[6n` with the current virtual position.
// The device then gets believable answers and stops probing.
export interface CursorWritable { write: (s: string) => unknown }
export function makeCursorResponder(stream: CursorWritable, rows = 24, cols = 200) {
  let row = 1, col = 1;
  return function respond(chunk: string): void {
    let i = 0;
    while (i < chunk.length) {
      const esc = chunk.indexOf("\x1b[", i);
      if (esc === -1) break;
      let j = esc + 2;
      let params = "";
      while (j < chunk.length && /[0-9;?]/.test(chunk[j])) { params += chunk[j]; j++; }
      if (j >= chunk.length) break; // sequence split across chunks — bail
      const letter = chunk[j];
      const n = parseInt(params, 10) || 1;
      if (letter === "A") row = Math.max(1, row - n);
      else if (letter === "B") row = Math.min(rows, row + n);
      else if (letter === "C") col = Math.min(cols, col + n);
      else if (letter === "D") col = Math.max(1, col - n);
      else if (letter === "H" || letter === "f") {
        const [r, c] = params.split(";");
        row = Math.min(Math.max(parseInt(r, 10) || 1, 1), rows);
        col = Math.min(Math.max(parseInt(c, 10) || 1, 1), cols);
      } else if (letter === "n" && params === "6") {
        try { stream.write(`\x1b[${row};${col}R`); } catch {}
      }
      i = j + 1;
    }
  };
}

// Flush whatever is left in a wire-log buffer when a stream closes — captures
// the final line of output that didn't end in a newline (common with prompts
// like `[admin@router] > `).
export function flushWireLog(
  log: string[],
  buffer: string,
  prefix: string,
): void {
  if (!buffer) return;
  if (log.length >= MAX_LOG_LINES) return;
  log.push(`[${ts()}] ${prefix} ${buffer}`);
}

// ─── Prompt Detection ───────────────────────────────────────────────
// These patterns detect interactive prompts in the SSH output buffer.
// Used to auto-confirm y/n prompts or pause for user input.

// Patterns that indicate a yes/no confirmation prompt
const CONFIRM_PATTERNS = [
  /\[y\/n\]\s*:?\s*$/i,
  /\[yes\/no\]\s*:?\s*$/i,
  /\(y\/n\)\s*:?\s*$/i,
  /\(yes\/no\)\s*:?\s*$/i,
  /are you sure\??\s*$/i,
  /do you really want to/i,
  /continue\?\s*\[y\/n\]/i,
  /proceed\?\s*$/i,
  /confirm\?\s*$/i,
  /\[y\]\s*:?\s*$/i,
];

// Patterns that indicate a generic input prompt (password, value entry, etc.)
const INPUT_PATTERNS = [
  /:\s*$/,
  /\?\s*$/,
  />\s*$/,
  /password\s*:?\s*$/i,
  /enter\s+\w+\s*:?\s*$/i,
  /type\s+\w+\s*:?\s*$/i,
  /value\s*:?\s*$/i,
  /number\s*:?\s*$/i,
  /name\s*:?\s*$/i,
  /input\s*:?\s*$/i,
];

// MikroTik CLI prompt pattern — excluded from input detection to avoid
// falsely treating the normal CLI prompt as an interactive question
const MIKROTIK_PROMPT = /\[[\w@\w.-]+\]\s*[>\/]\s*$/;

// Check the last 200 chars of the buffer for a y/n confirmation prompt
export function looksLikeConfirmPrompt(buffer: string): boolean {
  const lastChunk = buffer.slice(-200);
  return CONFIRM_PATTERNS.some(p => p.test(lastChunk));
}

// Pager prompts that appear when output exceeds the screen height. We auto-
// advance by writing a single space (which every common pager treats as
// "next page"). Patterns are matched against the ANSI-stripped tail.
//   --More--                  Cisco IOS, more(1), less(1)
//   --More-- (50%)            less with percentage
//   <--- More --->            HP ProCurve / Aruba
//   -- MORE --, next page:..  HP Comware
//   :                         less / more on a page boundary (too risky;
//                             not included — false positives on Password:)
const PAGER_PATTERNS: RegExp[] = [
  /--\s*more\s*--/i,
  /<---\s*more\s*--->/i,
  /-{2,}\s*more\s*-{2,}/i,
];

export function looksLikePagerPrompt(buffer: string): boolean {
  const tail = stripAnsi(buffer).slice(-120);
  return PAGER_PATTERNS.some(p => p.test(tail));
}

// Check the last 200 chars for a generic input prompt (excluding MikroTik CLI prompts)
export function looksLikeInputPrompt(buffer: string): boolean {
  const lastChunk = buffer.slice(-200);
  if (MIKROTIK_PROMPT.test(lastChunk)) return false;
  return INPUT_PATTERNS.some(p => p.test(lastChunk));
}

// Classify the current buffer tail as "confirm", "input", or null (no prompt)
export function detectPromptType(buffer: string): "confirm" | "input" | null {
  if (looksLikeConfirmPrompt(buffer)) return "confirm";
  if (looksLikeInputPrompt(buffer)) return "input";
  return null;
}

// Extract the last 3 lines from the buffer as the prompt text shown to the user
export function extractPromptText(buffer: string): string {
  const lines = buffer.trim().split("\n");
  const lastLines = lines.slice(-3);
  return lastLines.join("\n").trim();
}

// ─── Control Character Injection ────────────────────────────────────
// Supports <<CTRL+C>>, <<TAB>>, <<ESC>>, etc. syntax in scripts.
// These are translated to their ASCII byte equivalents before writing to the SSH stream.

const CONTROL_CHAR_MAP: Record<string, string> = {
  "CTRL+A": "\x01",
  "CTRL+B": "\x02",
  "CTRL+C": "\x03",
  "CTRL+D": "\x04",
  "CTRL+E": "\x05",
  "CTRL+F": "\x06",
  "CTRL+G": "\x07",
  "CTRL+H": "\x08",
  "TAB": "\x09",
  "CTRL+I": "\x09",
  "CTRL+J": "\x0A",
  "CTRL+K": "\x0B",
  "CTRL+L": "\x0C",
  "ENTER": "\r",
  "CTRL+M": "\r",
  "CTRL+N": "\x0E",
  "CTRL+O": "\x0F",
  "CTRL+P": "\x10",
  "CTRL+Q": "\x11",
  "CTRL+R": "\x12",
  "CTRL+S": "\x13",
  "CTRL+T": "\x14",
  "CTRL+U": "\x15",
  "CTRL+V": "\x16",
  "CTRL+W": "\x17",
  "CTRL+X": "\x18",
  "CTRL+Y": "\x19",
  "CTRL+Z": "\x1A",
  "ESC": "\x1B",
  "CTRL+[": "\x1B",
  "CTRL+\\": "\x1C",
  "CTRL+]": "\x1D",
  "DEL": "\x7F",
  "BACKSPACE": "\x08",
};

// Regex to match <<CTRL+C>> style tokens in command text
const CONTROL_CHAR_REGEX = /<<([A-Z+\\\[\]]+)>>/g;

// Write a command to the SSH stream, translating <<CTRL+X>> tokens to raw bytes.
// Regular text is written as-is; unrecognized tokens are passed through literally.
export function writeCommandWithControlChars(
  stream: NodeJS.WritableStream,
  command: string,
  appendNewline: boolean = true,
): void {
  // split() with a capture group interleaves text and matched groups:
  // even indices = text segments, odd indices = captured control char names
  const segments = command.split(CONTROL_CHAR_REGEX);
  for (let i = 0; i < segments.length; i++) {
    if (i % 2 === 0) {
      const text = segments[i];
      if (text) stream.write(text);
    } else {
      const key = segments[i].toUpperCase();
      const charByte = CONTROL_CHAR_MAP[key];
      if (charByte) {
        stream.write(charByte);
      } else {
        stream.write(`<<${segments[i]}>>`); // Unknown token — pass through unchanged
      }
    }
  }
  if (appendNewline) stream.write("\n");
}

// Quick check whether a script contains any <<...>> control char tokens
export function hasControlChars(script: string): boolean {
  return CONTROL_CHAR_REGEX.test(script);
}

export const SUPPORTED_CONTROL_CHARS = Object.keys(CONTROL_CHAR_MAP);

// ─── SSH Host Key Verification (TOFU) ───────────────────────────────
// Trust-on-first-use host key pinning. The first successful connection to
// a device records the SHA256 fingerprint of its public host key in
// `routers.ssh_host_key_fingerprint`. Every subsequent connection refuses
// to authenticate if the presented key does not match — defending against
// MITM attacks where an attacker on-path swaps the server.
//
// Operators can clear the pinned fingerprint via the admin "Re-pin" action
// when a device's host key legitimately rotates (factory reset, OS upgrade).
import crypto from "crypto";
import { db as _db, routersTable as _routersTable } from "@workspace/db";
import { eq as _eq, and, isNull } from "drizzle-orm";

export function sha256Fingerprint(key: Buffer): string {
  return "SHA256:" + crypto.createHash("sha256").update(key).digest("base64").replace(/=+$/, "");
}

export interface HostKeyTrust {
  routerId: number;
  expectedFingerprint: string | null;
}

// Build a hostVerifier callback that ssh2 invokes with the presented key buffer.
// Return true to accept, false to reject. On TOFU first-use we persist the
// fingerprint asynchronously without blocking auth (worst case: a concurrent
// connection also TOFUs and one wins; both are still pinned to the same key).
export function makeHostKeyVerifier(
  trust: HostKeyTrust,
  onMismatch: (presented: string, expected: string) => void,
): (key: Buffer) => boolean {
  return (key: Buffer) => {
    const presented = sha256Fingerprint(key);
    if (!trust.expectedFingerprint) {
      // TOFU: persist on first sight using compare-and-set so a concurrent
      // connection cannot race in and overwrite an already-pinned fingerprint.
      // We only set the column if it is still NULL; pin it locally so this
      // verifier won't accept a different key later in the same process.
      trust.expectedFingerprint = presented;
      _db.update(_routersTable)
        .set({ sshHostKeyFingerprint: presented })
        .where(and(_eq(_routersTable.id, trust.routerId), isNull(_routersTable.sshHostKeyFingerprint)))
        .catch((err) => console.error("[ssh] Failed to persist host key fingerprint:", err));
      return true;
    }
    if (presented === trust.expectedFingerprint) return true;
    onMismatch(presented, trust.expectedFingerprint);
    return false;
  };
}

// ─── SSH Algorithm Configuration ────────────────────────────────────
// Broad algorithm set for compatibility with older MikroTik RouterOS versions
// and other network equipment that may not support modern ciphers.
export const SSH_ALGORITHMS = {
  kex: [
    "diffie-hellman-group14-sha256",
    "diffie-hellman-group14-sha1",
    "diffie-hellman-group1-sha1",
    "ecdh-sha2-nistp256",
    "ecdh-sha2-nistp521",
  ],
  cipher: [
    "aes128-ctr",
    "aes192-ctr",
    "aes256-ctr",
    "aes128-cbc",
    "3des-cbc",
  ],
  serverHostKey: ["ssh-rsa", "ecdsa-sha2-nistp256", "ssh-dss"],
  hmac: ["hmac-sha2-256", "hmac-sha1", "hmac-md5"],
};

// ─── SSH Command Execution ──────────────────────────────────────────
// Connects to a device, runs a script, and returns the full output + connection log.
// Two modes:
//   autoConfirm=true  → opens an interactive shell, auto-answers y/n prompts with "y"
//   autoConfirm=false → uses SSH exec (non-interactive, no prompt handling)
export async function executeSSHCommand(
  host: string,
  port: number,
  username: string,
  password: string,
  command: string,
  timeoutMs: number = 30000,
  autoConfirm: boolean = true
): Promise<SSHResult> {
  return new Promise((resolve) => {
    const conn = new Client();
    let output = "";
    let stderr = "";
    let timedOut = false;
    const log: string[] = [];

    // Build connection log header
    log.push(`[${ts()}] SSH session initiated`);
    log.push(`[${ts()}] Target: ${username}@${host}:${port}`);
    log.push(`[${ts()}] Timeout: ${timeoutMs}ms`);
    log.push(`[${ts()}] Auto-confirm: ${autoConfirm ? "enabled" : "disabled"}`);
    log.push(`[${ts()}] Connecting...`);

    // Global timeout — kills the connection if it takes too long
    const timer = setTimeout(() => {
      timedOut = true;
      log.push(`[${ts()}] ERROR: Connection timed out after ${timeoutMs}ms`);
      conn.end();
      resolve({
        success: false,
        output: "",
        errorMessage: "Connection timed out",
        connectionLog: log.join("\n"),
      });
    }, timeoutMs);

    // Log SSH handshake details (KEX algorithm, cipher, host key type)
    conn.on("handshake", (negotiated) => {
      log.push(`[${ts()}] Handshake complete`);
      log.push(`[${ts()}]   KEX: ${negotiated.kex}`);
      log.push(`[${ts()}]   Cipher (C→S): ${negotiated.cs.cipher}`);
      log.push(`[${ts()}]   Server host key: ${negotiated.serverHostKey}`);
    });

    conn.on("ready", () => {
      log.push(`[${ts()}] Authentication successful`);
      log.push(`[${ts()}] Mode: ${autoConfirm ? "interactive shell (auto-confirm)" : "exec"}`);
      log.push(`[${ts()}] Executing command...`);
      log.push(`[${ts()}] ──────────────────────────────────`);

      if (autoConfirm) {
        // ── Interactive shell mode ──
        // Opens a shell, sends the command, and auto-responds "y" to confirmation prompts.
        // Closes after 3 seconds of idle (no new data).
        // PTY: explicit rows/cols/term so MikroTik RouterOS et al. don't sit
        // forever waiting for a DSR reply to their terminal-size probe. See
        // the matching block in interactive-session.ts for the full story.
        conn.shell({ rows: 24, cols: 200, term: "vt100" }, (err, stream) => {
          if (err) {
            clearTimeout(timer);
            log.push(`[${ts()}] ERROR: shell failed — ${err.message}`);
            log.push(`[${ts()}] Session closed`);
            conn.end();
            resolve({ success: false, output: "", errorMessage: err.message, connectionLog: log.join("\n") });
            return;
          }

          let shellBuffer = "";
          let commandSent = false;
          let autoConfirmCount = 0;
          let lastPromptChecked = "";  // Deduplication: prevents re-confirming the same prompt
          let pagerAdvanceCount = 0;
          let lastPagerChecked = "";   // Deduplication: prevents re-spacing the same pager prompt
          const cursorRespond = makeCursorResponder(stream, 24, 200);
          let promptTick: ReturnType<typeof setInterval> | null = null;

          // Idle timer: resolves the session after a window of no new data.
          // We use a much longer window (25s) BEFORE the command is sent —
          // the prompt-wait poll has a 20s ceiling, and chatty devices like
          // RouterOS can sit silent for several seconds mid-handshake while
          // they wait for our DSR replies. After commandSent we drop back
          // to 3s, since the command-response cycle should be tight.
          const idleTimer = { ref: null as ReturnType<typeof setTimeout> | null };
          const resetIdleTimer = () => {
            if (idleTimer.ref) clearTimeout(idleTimer.ref);
            idleTimer.ref = setTimeout(() => {
              clearTimeout(timer);
              if (promptTick) { clearInterval(promptTick); promptTick = null; }
              log.push(`[${ts()}] ──────────────────────────────────`);
              log.push(`[${ts()}] Shell session idle — closing`);
              if (autoConfirmCount > 0) log.push(`[${ts()}] Auto-confirmed ${autoConfirmCount} prompt(s)`);
              log.push(`[${ts()}] Session closed`);
              conn.end();
              if (!timedOut) {
                resolve({ success: true, output: tidyText(shellBuffer), connectionLog: log.join("\n") });
              }
            }, commandSent ? 10000 : 25000);
          };

          // Per-direction line buffers for the wire log (see appendWireLog).
          let recvBuf = "";
          let stderrBuf = "";

          stream.on("close", () => {
            clearTimeout(timer);
            if (idleTimer.ref) clearTimeout(idleTimer.ref);
            if (promptTick) { clearInterval(promptTick); promptTick = null; }
            flushWireLog(log, recvBuf, "<<");  recvBuf = "";
            flushWireLog(log, stderrBuf, "<<E"); stderrBuf = "";
            log.push(`[${ts()}] ──────────────────────────────────`);
            if (autoConfirmCount > 0) log.push(`[${ts()}] Auto-confirmed ${autoConfirmCount} prompt(s)`);
            log.push(`[${ts()}] Session closed`);
            conn.end();
            if (!timedOut) {
              resolve({ success: true, output: tidyText(shellBuffer), connectionLog: log.join("\n") });
            }
          });

          stream.on("data", (data: Buffer) => {
            const chunk = data.toString("binary");
            shellBuffer += chunk;
            output += chunk;
            recvBuf = appendWireLog(log, recvBuf, "<<", chunk);
            resetIdleTimer();

            // Smart DSR responder — tracks a virtual 24×200 cursor and
            // replies to \x1b[6n with believable positions. See
            // makeCursorResponder() for the full rationale.
            cursorRespond(chunk);

            if (!commandSent) return;

            // Pager auto-advance — write a space when --More-- / HP MORE
            // appears so Cisco/HP/Linux output that overflows a screen
            // doesn't stall the session.
            const pagerTail = shellBuffer.slice(-160);
            if (pagerTail !== lastPagerChecked && looksLikePagerPrompt(shellBuffer)) {
              lastPagerChecked = pagerTail;
              pagerAdvanceCount++;
              log.push(`[${ts()}] Pager prompt #${pagerAdvanceCount}: sending space`);
              stream.write(" ");
            }

            // Check if the output tail looks like a y/n prompt and auto-respond
            const currentTail = shellBuffer.slice(-200);
            if (currentTail !== lastPromptChecked && looksLikeConfirmPrompt(shellBuffer)) {
              lastPromptChecked = currentTail;
              autoConfirmCount++;
              log.push(`[${ts()}] Auto-confirm #${autoConfirmCount}: detected prompt, sending "y"`);
              stream.write("y\n");
            }
          });

          stream.stderr.on("data", (data: Buffer) => {
            const chunk = data.toString("binary");
            stderr += chunk;
            stderrBuf = appendWireLog(log, stderrBuf, "<<E", chunk);
          });

          // ─── Wait for shell prompt before sending the command ──
          // Same logic as interactive-session.ts: poll the buffer for a
          // prompt-shaped tail (CLI prompt char at end, ANSI-stripped) up
          // to a 20s ceiling. See that file for the full rationale.
          const PROMPT_RE = /(?:^|\n)[^\n]*[>#$%\]:][ \t]*$/;
          const PROMPT_CEILING_MS = 20_000;
          const promptStart = Date.now();
          log.push(`[${ts()}] Waiting for shell prompt (max ${PROMPT_CEILING_MS / 1000}s)`);
          promptTick = setInterval(() => {
            const cleaned = stripAnsi(shellBuffer);
            const ready = PROMPT_RE.test(cleaned);
            const ceiling = Date.now() - promptStart >= PROMPT_CEILING_MS;
            if (!ready && !ceiling) return;
            if (promptTick) { clearInterval(promptTick); promptTick = null; }
            const waited = Date.now() - promptStart;
            if (ready) {
              log.push(`[${ts()}] Shell prompt detected after ${waited}ms`);
            } else {
              log.push(`[${ts()}] No shell prompt detected after ${waited}ms — sending command anyway`);
            }
            commandSent = true;
            log.push(`[${ts()}] Executing command (${command.split("\n").length} line(s)):`);
            appendWireLog(log, "", ">>", command + "\n");
            writeCommandWithControlChars(stream, command);
            resetIdleTimer();
          }, 100);
        });
      } else {
        // ── Exec mode ──
        // Runs the command non-interactively. No prompt detection or auto-confirm.
        conn.exec(command, (err, stream) => {
          if (err) {
            clearTimeout(timer);
            log.push(`[${ts()}] ERROR: exec failed — ${err.message}`);
            log.push(`[${ts()}] Session closed`);
            conn.end();
            resolve({ success: false, output: "", errorMessage: err.message, connectionLog: log.join("\n") });
            return;
          }

          // Per-direction line buffers for the wire log.
          let recvBuf = "";
          let stderrBuf = "";

          // Log the command before any output can echo back.
          log.push(`[${ts()}] Executing command (${command.split("\n").length} line(s)):`);
          appendWireLog(log, "", ">>", command + "\n");

          stream.on("close", (code: number) => {
            clearTimeout(timer);
            flushWireLog(log, recvBuf, "<<");  recvBuf = "";
            flushWireLog(log, stderrBuf, "<<E"); stderrBuf = "";
            log.push(`[${ts()}] ──────────────────────────────────`);
            log.push(`[${ts()}] Command exited with code: ${code}`);
            log.push(`[${ts()}] Session closed`);
            conn.end();
            if (!timedOut) {
              resolve({
                success: code === 0,
                output: tidyText(output),
                errorMessage: code !== 0 ? (stderr.trim() || `Exit code: ${code}`) : undefined,
                connectionLog: log.join("\n"),
              });
            }
          });

          stream.on("data", (data: Buffer) => {
            const chunk = data.toString("binary");
            output += chunk;
            recvBuf = appendWireLog(log, recvBuf, "<<", chunk);
          });
          stream.stderr.on("data", (data: Buffer) => {
            const chunk = data.toString("binary");
            stderr += chunk;
            stderrBuf = appendWireLog(log, stderrBuf, "<<E", chunk);
          });
        });
      }
    });

    conn.on("error", (err) => {
      clearTimeout(timer);
      log.push(`[${ts()}] ERROR: ${err.message}`);
      log.push(`[${ts()}] Session closed`);
      if (!timedOut) {
        resolve({ success: false, output: "", errorMessage: err.message, connectionLog: log.join("\n") });
      }
    });

    try {
      conn.connect({ host, port, username, password, readyTimeout: timeoutMs, algorithms: SSH_ALGORITHMS });
    } catch (err: any) {
      clearTimeout(timer);
      log.push(`[${ts()}] ERROR: Failed to initiate connection — ${err.message}`);
      resolve({ success: false, output: "", errorMessage: err.message, connectionLog: log.join("\n") });
    }
  });
}

// ─── Jump host / enable password / retry wrappers ──────────────────

export interface JumpHostConfig {
  host: string;
  port: number;
  username: string;
  password: string;
}

export interface SSHExecOptions {
  timeoutMs?: number;
  autoConfirm?: boolean;
  enablePassword?: string;
  jumpHost?: JumpHostConfig;
  retryCount?: number;
  retryBackoffSeconds?: number;
  /** Called for each attempt with attemptIndex (1-based). */
  onAttempt?: (attemptIndex: number) => void;
  /** Trust-on-first-use host key pinning. When set, the first connection
   * persists the device's host key fingerprint and every subsequent
   * connection refuses to authenticate if the presented key changes. */
  hostKeyTrust?: HostKeyTrust;
}

// Detect transient/connection-level failures that are worth retrying.
// We don't retry auth failures, missing-password, post-success, or timeouts caused by hung shells.
function isRetryableError(msg?: string): boolean {
  if (!msg) return false;
  const m = msg.toLowerCase();
  if (m.includes("auth")) return false;
  if (m.includes("password")) return false;
  return (
    m.includes("connect") ||
    m.includes("timed out") ||
    m.includes("timeout") ||
    m.includes("ehostunreach") ||
    m.includes("econnrefused") ||
    m.includes("econnreset") ||
    m.includes("enetunreach") ||
    m.includes("eai_again") ||
    m.includes("etimedout") ||
    m.includes("handshake")
  );
}

// Open an SSH connection that goes through a jump host using ssh2's forwardOut.
// Exported so interactive sessions (which don't go through executeSSH) can
// also route through a bastion.
export async function connectViaJumpHost(
  target: { host: string; port: number; username: string; password: string; hostKeyTrust?: HostKeyTrust },
  jump: JumpHostConfig,
  timeoutMs: number,
  log: string[],
): Promise<Client> {
  return new Promise((resolve, reject) => {
    const jumpConn = new Client();
    log.push(`[${ts()}] Jump host: ${jump.username}@${jump.host}:${jump.port}`);

    jumpConn.on("ready", () => {
      log.push(`[${ts()}] Jump host authenticated, forwarding to ${target.host}:${target.port}`);
      jumpConn.forwardOut("127.0.0.1", 0, target.host, target.port, (err, stream) => {
        if (err) {
          jumpConn.end();
          reject(new Error(`forwardOut failed: ${err.message}`));
          return;
        }
        const targetConn = new Client();
        targetConn.on("ready", () => {
          // Keep the jump connection alive for the lifetime of the target one.
          targetConn.once("end", () => jumpConn.end());
          targetConn.once("close", () => jumpConn.end());
          resolve(targetConn);
        });
        targetConn.on("error", (e) => {
          jumpConn.end();
          reject(e);
        });
        try {
          const cfg: any = {
            sock: stream as any,
            username: target.username,
            password: target.password,
            readyTimeout: timeoutMs,
            algorithms: SSH_ALGORITHMS,
          };
          if (target.hostKeyTrust) {
            cfg.hostVerifier = makeHostKeyVerifier(target.hostKeyTrust, (presented, expected) => {
              log.push(`[${ts()}] ERROR: Host key MISMATCH for ${target.host} (presented ${presented}, expected ${expected})`);
            });
          }
          targetConn.connect(cfg);
        } catch (e: any) {
          jumpConn.end();
          reject(e);
        }
      });
    });

    jumpConn.on("error", (err) => reject(err));

    try {
      jumpConn.connect({
        host: jump.host,
        port: jump.port,
        username: jump.username,
        password: jump.password,
        readyTimeout: timeoutMs,
        algorithms: SSH_ALGORITHMS,
      });
    } catch (e: any) {
      reject(e);
    }
  });
}

// Run executeSSHCommand once with a custom Client factory, supporting jump host
// and an optional enable-password handler. This is the primary single-attempt path.
async function executeOnce(
  host: string,
  port: number,
  username: string,
  password: string,
  command: string,
  options: SSHExecOptions,
): Promise<SSHResult> {
  const timeoutMs = options.timeoutMs ?? 30000;
  const autoConfirm = options.autoConfirm ?? true;
  const enablePassword = options.enablePassword;
  const jumpHost = options.jumpHost;
  const hostKeyTrust = options.hostKeyTrust;
  const log: string[] = [];
  let output = "";
  let stderr = "";
  let timedOut = false;

  log.push(`[${ts()}] SSH session initiated`);
  log.push(`[${ts()}] Target: ${username}@${host}:${port}`);
  log.push(`[${ts()}] Timeout: ${timeoutMs}ms`);
  log.push(`[${ts()}] Auto-confirm: ${autoConfirm ? "enabled" : "disabled"}`);
  if (enablePassword) log.push(`[${ts()}] Enable-password handler: armed`);
  if (jumpHost) log.push(`[${ts()}] Routing through jump host`);

  let conn: Client;
  try {
    conn = jumpHost
      ? await connectViaJumpHost({ host, port, username, password, hostKeyTrust }, jumpHost, timeoutMs, log)
      : await new Promise<Client>((resolve, reject) => {
          const c = new Client();
          c.once("ready", () => resolve(c));
          c.once("error", (e) => reject(e));
          try {
            const cfg: any = { host, port, username, password, readyTimeout: timeoutMs, algorithms: SSH_ALGORITHMS };
            if (hostKeyTrust) {
              cfg.hostVerifier = makeHostKeyVerifier(hostKeyTrust, (presented, expected) => {
                log.push(`[${ts()}] ERROR: Host key MISMATCH for ${host} (presented ${presented}, expected ${expected})`);
              });
            }
            c.connect(cfg);
          } catch (e: any) { reject(e); }
        });
  } catch (err: any) {
    log.push(`[${ts()}] ERROR: ${err.message}`);
    return { success: false, output: "", errorMessage: err.message, connectionLog: log.join("\n") };
  }

  return new Promise<SSHResult>((resolve) => {
    log.push(`[${ts()}] Authentication successful`);
    log.push(`[${ts()}] Mode: ${autoConfirm ? "interactive shell (auto-confirm)" : "exec"}`);
    log.push(`[${ts()}] Executing command...`);
    log.push(`[${ts()}] ──────────────────────────────────`);

    const timer = setTimeout(() => {
      timedOut = true;
      log.push(`[${ts()}] ERROR: Connection timed out after ${timeoutMs}ms`);
      try { conn.end(); } catch {}
      resolve({ success: false, output: output, errorMessage: "Connection timed out", connectionLog: log.join("\n") });
    }, timeoutMs);

    if (autoConfirm) {
      // PTY: explicit rows/cols/term — see interactive-session.ts for the
      // full reasoning. Skips the RouterOS terminal-size probe that would
      // otherwise pin the shell waiting for a DSR reply.
      conn.shell({ rows: 24, cols: 200, term: "vt100" }, (err, stream) => {
        if (err) {
          clearTimeout(timer);
          log.push(`[${ts()}] ERROR: shell failed — ${err.message}`);
          try { conn.end(); } catch {}
          resolve({ success: false, output: "", errorMessage: err.message, connectionLog: log.join("\n") });
          return;
        }
        let shellBuffer = "";
        let commandSent = false;
        let autoConfirmCount = 0;
        let lastPromptChecked = "";
        let pagerAdvanceCount = 0;
        let lastPagerChecked = "";
        let enableSent = false;
        const cursorRespond = makeCursorResponder(stream, 24, 200);
        let promptTick: ReturnType<typeof setInterval> | null = null;
        // Per-direction line buffers for the wire log.
        let recvBuf = "";
        let stderrBuf = "";
        // Idle timer: 25s while waiting for the prompt (longer than the 20s
        // prompt-wait ceiling) to avoid killing the session mid-handshake on
        // chatty devices like RouterOS, then 3s once the command is sent.
        const idleTimer = { ref: null as ReturnType<typeof setTimeout> | null };
        const resetIdleTimer = () => {
          if (idleTimer.ref) clearTimeout(idleTimer.ref);
          idleTimer.ref = setTimeout(() => {
            clearTimeout(timer);
            if (promptTick) { clearInterval(promptTick); promptTick = null; }
            flushWireLog(log, recvBuf, "<<");  recvBuf = "";
            flushWireLog(log, stderrBuf, "<<E"); stderrBuf = "";
            log.push(`[${ts()}] ──────────────────────────────────`);
            log.push(`[${ts()}] Shell session idle — closing`);
            if (autoConfirmCount > 0) log.push(`[${ts()}] Auto-confirmed ${autoConfirmCount} prompt(s)`);
            log.push(`[${ts()}] Session closed`);
            try { conn.end(); } catch {}
            if (!timedOut) resolve({ success: true, output: tidyText(shellBuffer), connectionLog: log.join("\n") });
          }, commandSent ? 10000 : 25000);
        };
        stream.on("close", () => {
          clearTimeout(timer);
          if (idleTimer.ref) clearTimeout(idleTimer.ref);
          if (promptTick) { clearInterval(promptTick); promptTick = null; }
          flushWireLog(log, recvBuf, "<<");  recvBuf = "";
          flushWireLog(log, stderrBuf, "<<E"); stderrBuf = "";
          log.push(`[${ts()}] ──────────────────────────────────`);
          if (autoConfirmCount > 0) log.push(`[${ts()}] Auto-confirmed ${autoConfirmCount} prompt(s)`);
          log.push(`[${ts()}] Session closed`);
          try { conn.end(); } catch {}
          if (!timedOut) resolve({ success: true, output: tidyText(shellBuffer), connectionLog: log.join("\n") });
        });
        stream.on("data", (data: Buffer) => {
          const chunk = data.toString("binary");
          shellBuffer += chunk;
          output += chunk;
          recvBuf = appendWireLog(log, recvBuf, "<<", chunk);
          resetIdleTimer();
          // Smart DSR responder — see makeCursorResponder() for the full story.
          cursorRespond(chunk);
          if (!commandSent) return;
          const tail = shellBuffer.slice(-200);
          // Enable password handler: respond once, only when we have a password and it differs from the SSH one
          if (
            enablePassword && !enableSent && enablePassword !== password &&
            /password\s*:?\s*$/i.test(tail)
          ) {
            enableSent = true;
            log.push(`[${ts()}] Enable-password prompt detected, sending stored secret`);
            stream.write(enablePassword + "\n");
            return;
          }
          // Pager auto-advance
          const pagerTail2 = shellBuffer.slice(-160);
          if (pagerTail2 !== lastPagerChecked && looksLikePagerPrompt(shellBuffer)) {
            lastPagerChecked = pagerTail2;
            pagerAdvanceCount++;
            log.push(`[${ts()}] Pager prompt #${pagerAdvanceCount}: sending space`);
            stream.write(" ");
            return;
          }
          if (tail !== lastPromptChecked && looksLikeConfirmPrompt(shellBuffer)) {
            lastPromptChecked = tail;
            autoConfirmCount++;
            log.push(`[${ts()}] Auto-confirm #${autoConfirmCount}: detected prompt, sending "y"`);
            stream.write("y\n");
          }
        });
        stream.stderr.on("data", (data: Buffer) => {
          const chunk = data.toString("binary");
          stderr += chunk;
          stderrBuf = appendWireLog(log, stderrBuf, "<<E", chunk);
        });
        // Wait for the shell prompt (max 20s) instead of a fixed 500ms —
        // see the matching block above for the full rationale.
        const PROMPT_RE = /(?:^|\n)[^\n]*[>#$%\]:][ \t]*$/;
        const PROMPT_CEILING_MS = 20_000;
        const promptStart = Date.now();
        log.push(`[${ts()}] Waiting for shell prompt (max ${PROMPT_CEILING_MS / 1000}s)`);
        promptTick = setInterval(() => {
          const cleaned = stripAnsi(shellBuffer);
          const ready = PROMPT_RE.test(cleaned);
          const ceiling = Date.now() - promptStart >= PROMPT_CEILING_MS;
          if (!ready && !ceiling) return;
          if (promptTick) { clearInterval(promptTick); promptTick = null; }
          const waited = Date.now() - promptStart;
          if (ready) {
            log.push(`[${ts()}] Shell prompt detected after ${waited}ms`);
          } else {
            log.push(`[${ts()}] No shell prompt detected after ${waited}ms — sending command anyway`);
          }
          commandSent = true;
          log.push(`[${ts()}] Executing command (${command.split("\n").length} line(s)):`);
          appendWireLog(log, "", ">>", command + "\n");
          writeCommandWithControlChars(stream, command);
          resetIdleTimer();
        }, 100);
      });
    } else {
      conn.exec(command, (err, stream) => {
        if (err) {
          clearTimeout(timer);
          log.push(`[${ts()}] ERROR: exec failed — ${err.message}`);
          try { conn.end(); } catch {}
          resolve({ success: false, output: "", errorMessage: err.message, connectionLog: log.join("\n") });
          return;
        }
        let recvBuf = "";
        let stderrBuf = "";
        log.push(`[${ts()}] Executing command (${command.split("\n").length} line(s)):`);
        appendWireLog(log, "", ">>", command + "\n");
        stream.on("close", (code: number) => {
          clearTimeout(timer);
          flushWireLog(log, recvBuf, "<<");  recvBuf = "";
          flushWireLog(log, stderrBuf, "<<E"); stderrBuf = "";
          log.push(`[${ts()}] ──────────────────────────────────`);
          log.push(`[${ts()}] Command exited with code: ${code}`);
          log.push(`[${ts()}] Session closed`);
          try { conn.end(); } catch {}
          if (!timedOut) {
            resolve({
              success: code === 0,
              output: tidyText(output),
              errorMessage: code !== 0 ? (stderr.trim() || `Exit code: ${code}`) : undefined,
              connectionLog: log.join("\n"),
            });
          }
        });
        stream.on("data", (data: Buffer) => {
          const chunk = data.toString("binary");
          output += chunk;
          recvBuf = appendWireLog(log, recvBuf, "<<", chunk);
        });
        stream.stderr.on("data", (data: Buffer) => {
          const chunk = data.toString("binary");
          stderr += chunk;
          stderrBuf = appendWireLog(log, stderrBuf, "<<E", chunk);
        });
      });
    }

    conn.on("error", (err) => {
      clearTimeout(timer);
      log.push(`[${ts()}] ERROR: ${err.message}`);
      if (!timedOut) {
        resolve({ success: false, output: "", errorMessage: err.message, connectionLog: log.join("\n") });
      }
    });
  });
}

// Public entry point with retry + jump host + enable password support.
export async function executeSSH(
  host: string,
  port: number,
  username: string,
  password: string,
  command: string,
  options: SSHExecOptions = {},
): Promise<SSHResult & { attemptCount: number }> {
  const retryCount = Math.max(0, Math.min(10, options.retryCount ?? 0));
  const backoffMs = Math.max(0, options.retryBackoffSeconds ?? 5) * 1000;
  let last: SSHResult = { success: false, output: "", errorMessage: "no attempt", connectionLog: "" };
  let attempts = 0;
  for (let i = 0; i <= retryCount; i++) {
    attempts++;
    options.onAttempt?.(attempts);
    last = await executeOnce(host, port, username, password, command, options);
    if (last.success) break;
    if (i >= retryCount) break;
    if (!isRetryableError(last.errorMessage)) break;
    if (backoffMs > 0) await new Promise((r) => setTimeout(r, backoffMs));
  }
  return { ...last, attemptCount: attempts };
}

// ─── Tag Substitution ───────────────────────────────────────────────
// Replace {{TAG_NAME}} placeholders in a script with values from an Excel/CSV row.
// Whitespace inside braces is tolerated: {{ TAG }} works the same as {{TAG}}.
export function applyTagSubstitution(
  script: string,
  row: Record<string, string>
): string {
  let result = script;
  for (const [key, value] of Object.entries(row)) {
    const tag = new RegExp(`\\{\\{\\s*${escapeRegex(key)}\\s*\\}\\}`, "g");
    result = result.replace(tag, value);
  }
  return result;
}

// Escape special regex characters in a string so it can be used in new RegExp()
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
