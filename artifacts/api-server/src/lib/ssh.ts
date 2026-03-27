import { Client } from "ssh2";

export interface SSHResult {
  success: boolean;
  output: string;
  errorMessage?: string;
  connectionLog: string;
}

function ts(): string {
  return new Date().toISOString().replace("T", " ").replace("Z", "");
}

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

const MIKROTIK_PROMPT = /\[[\w@\w.-]+\]\s*[>\/]\s*$/;

export function looksLikeConfirmPrompt(buffer: string): boolean {
  const lastChunk = buffer.slice(-200);
  return CONFIRM_PATTERNS.some(p => p.test(lastChunk));
}

export function looksLikeInputPrompt(buffer: string): boolean {
  const lastChunk = buffer.slice(-200);
  if (MIKROTIK_PROMPT.test(lastChunk)) return false;
  return INPUT_PATTERNS.some(p => p.test(lastChunk));
}

export function detectPromptType(buffer: string): "confirm" | "input" | null {
  if (looksLikeConfirmPrompt(buffer)) return "confirm";
  if (looksLikeInputPrompt(buffer)) return "input";
  return null;
}

export function extractPromptText(buffer: string): string {
  const lines = buffer.trim().split("\n");
  const lastLines = lines.slice(-3);
  return lastLines.join("\n").trim();
}

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

    log.push(`[${ts()}] SSH session initiated`);
    log.push(`[${ts()}] Target: ${username}@${host}:${port}`);
    log.push(`[${ts()}] Timeout: ${timeoutMs}ms`);
    log.push(`[${ts()}] Auto-confirm: ${autoConfirm ? "enabled" : "disabled"}`);
    log.push(`[${ts()}] Connecting...`);

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
          let lastPromptChecked = "";

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

          setTimeout(() => {
            commandSent = true;
            stream.write(command + "\n");
            resetIdleTimer();
          }, 500);
        });
      } else {
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

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
