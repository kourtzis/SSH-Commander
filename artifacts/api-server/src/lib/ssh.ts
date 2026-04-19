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
        conn.shell((err, stream) => {
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

          // Idle timer: resolves the session if no new data arrives for 3 seconds
          const idleTimer = { ref: null as ReturnType<typeof setTimeout> | null };
          const resetIdleTimer = () => {
            if (idleTimer.ref) clearTimeout(idleTimer.ref);
            idleTimer.ref = setTimeout(() => {
              clearTimeout(timer);
              log.push(`[${ts()}] ──────────────────────────────────`);
              log.push(`[${ts()}] Shell session idle — closing`);
              if (autoConfirmCount > 0) log.push(`[${ts()}] Auto-confirmed ${autoConfirmCount} prompt(s)`);
              log.push(`[${ts()}] Session closed`);
              conn.end();
              if (!timedOut) {
                resolve({ success: true, output: shellBuffer.trim(), connectionLog: log.join("\n") });
              }
            }, 3000);
          };

          stream.on("close", () => {
            clearTimeout(timer);
            if (idleTimer.ref) clearTimeout(idleTimer.ref);
            log.push(`[${ts()}] ──────────────────────────────────`);
            if (autoConfirmCount > 0) log.push(`[${ts()}] Auto-confirmed ${autoConfirmCount} prompt(s)`);
            log.push(`[${ts()}] Session closed`);
            conn.end();
            if (!timedOut) {
              resolve({ success: true, output: shellBuffer.trim(), connectionLog: log.join("\n") });
            }
          });

          stream.on("data", (data: Buffer) => {
            const chunk = data.toString();
            shellBuffer += chunk;
            output += chunk;
            resetIdleTimer();

            if (!commandSent) return;

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
            stderr += data.toString();
          });

          // Delay command sending by 500ms to let the shell banner/MOTD arrive first
          setTimeout(() => {
            commandSent = true;
            writeCommandWithControlChars(stream, command);
            resetIdleTimer();
          }, 500);
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

          stream.on("close", (code: number) => {
            clearTimeout(timer);
            log.push(`[${ts()}] ──────────────────────────────────`);
            log.push(`[${ts()}] Command exited with code: ${code}`);
            if (stderr.trim()) log.push(`[${ts()}] STDERR: ${stderr.trim()}`);
            log.push(`[${ts()}] Session closed`);
            conn.end();
            if (!timedOut) {
              resolve({
                success: code === 0,
                output: output.trim(),
                errorMessage: code !== 0 ? (stderr.trim() || `Exit code: ${code}`) : undefined,
                connectionLog: log.join("\n"),
              });
            }
          });

          stream.on("data", (data: Buffer) => { output += data.toString(); });
          stream.stderr.on("data", (data: Buffer) => { stderr += data.toString(); });
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
async function connectViaJumpHost(
  target: { host: string; port: number; username: string; password: string },
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
          targetConn.connect({
            sock: stream as any,
            username: target.username,
            password: target.password,
            readyTimeout: timeoutMs,
            algorithms: SSH_ALGORITHMS,
          });
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
      ? await connectViaJumpHost({ host, port, username, password }, jumpHost, timeoutMs, log)
      : await new Promise<Client>((resolve, reject) => {
          const c = new Client();
          c.once("ready", () => resolve(c));
          c.once("error", (e) => reject(e));
          try {
            c.connect({ host, port, username, password, readyTimeout: timeoutMs, algorithms: SSH_ALGORITHMS });
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
      conn.shell((err, stream) => {
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
        let enableSent = false;
        const idleTimer = { ref: null as ReturnType<typeof setTimeout> | null };
        const resetIdleTimer = () => {
          if (idleTimer.ref) clearTimeout(idleTimer.ref);
          idleTimer.ref = setTimeout(() => {
            clearTimeout(timer);
            log.push(`[${ts()}] ──────────────────────────────────`);
            log.push(`[${ts()}] Shell session idle — closing`);
            if (autoConfirmCount > 0) log.push(`[${ts()}] Auto-confirmed ${autoConfirmCount} prompt(s)`);
            log.push(`[${ts()}] Session closed`);
            try { conn.end(); } catch {}
            if (!timedOut) resolve({ success: true, output: shellBuffer.trim(), connectionLog: log.join("\n") });
          }, 3000);
        };
        stream.on("close", () => {
          clearTimeout(timer);
          if (idleTimer.ref) clearTimeout(idleTimer.ref);
          log.push(`[${ts()}] ──────────────────────────────────`);
          if (autoConfirmCount > 0) log.push(`[${ts()}] Auto-confirmed ${autoConfirmCount} prompt(s)`);
          log.push(`[${ts()}] Session closed`);
          try { conn.end(); } catch {}
          if (!timedOut) resolve({ success: true, output: shellBuffer.trim(), connectionLog: log.join("\n") });
        });
        stream.on("data", (data: Buffer) => {
          const chunk = data.toString();
          shellBuffer += chunk;
          output += chunk;
          resetIdleTimer();
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
          if (tail !== lastPromptChecked && looksLikeConfirmPrompt(shellBuffer)) {
            lastPromptChecked = tail;
            autoConfirmCount++;
            log.push(`[${ts()}] Auto-confirm #${autoConfirmCount}: detected prompt, sending "y"`);
            stream.write("y\n");
          }
        });
        stream.stderr.on("data", (data: Buffer) => { stderr += data.toString(); });
        setTimeout(() => {
          commandSent = true;
          writeCommandWithControlChars(stream, command);
          resetIdleTimer();
        }, 500);
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
        stream.on("close", (code: number) => {
          clearTimeout(timer);
          log.push(`[${ts()}] ──────────────────────────────────`);
          log.push(`[${ts()}] Command exited with code: ${code}`);
          if (stderr.trim()) log.push(`[${ts()}] STDERR: ${stderr.trim()}`);
          log.push(`[${ts()}] Session closed`);
          try { conn.end(); } catch {}
          if (!timedOut) {
            resolve({
              success: code === 0,
              output: output.trim(),
              errorMessage: code !== 0 ? (stderr.trim() || `Exit code: ${code}`) : undefined,
              connectionLog: log.join("\n"),
            });
          }
        });
        stream.on("data", (data: Buffer) => { output += data.toString(); });
        stream.stderr.on("data", (data: Buffer) => { stderr += data.toString(); });
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
