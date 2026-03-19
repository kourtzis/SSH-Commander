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

export async function executeSSHCommand(
  host: string,
  port: number,
  username: string,
  password: string,
  command: string,
  timeoutMs: number = 30000
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
      log.push(`[${ts()}] Executing command...`);
      log.push(`[${ts()}] ──────────────────────────────────`);

      conn.exec(command, (err, stream) => {
        if (err) {
          clearTimeout(timer);
          log.push(`[${ts()}] ERROR: exec failed — ${err.message}`);
          log.push(`[${ts()}] Session closed`);
          conn.end();
          resolve({
            success: false,
            output: "",
            errorMessage: err.message,
            connectionLog: log.join("\n"),
          });
          return;
        }

        stream.on("close", (code: number) => {
          clearTimeout(timer);
          log.push(`[${ts()}] ──────────────────────────────────`);
          log.push(`[${ts()}] Command exited with code: ${code}`);
          if (stderr.trim()) {
            log.push(`[${ts()}] STDERR: ${stderr.trim()}`);
          }
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

        stream.on("data", (data: Buffer) => {
          output += data.toString();
        });

        stream.stderr.on("data", (data: Buffer) => {
          stderr += data.toString();
        });
      });
    });

    conn.on("error", (err) => {
      clearTimeout(timer);
      log.push(`[${ts()}] ERROR: ${err.message}`);
      log.push(`[${ts()}] Session closed`);
      if (!timedOut) {
        resolve({
          success: false,
          output: "",
          errorMessage: err.message,
          connectionLog: log.join("\n"),
        });
      }
    });

    try {
      conn.connect({
        host,
        port,
        username,
        password,
        readyTimeout: timeoutMs,
        algorithms: {
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
        },
      });
    } catch (err: any) {
      clearTimeout(timer);
      log.push(`[${ts()}] ERROR: Failed to initiate connection — ${err.message}`);
      resolve({
        success: false,
        output: "",
        errorMessage: err.message,
        connectionLog: log.join("\n"),
      });
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
