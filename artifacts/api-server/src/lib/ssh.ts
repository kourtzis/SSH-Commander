import { Client } from "ssh2";

export interface SSHResult {
  success: boolean;
  output: string;
  errorMessage?: string;
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

    const timer = setTimeout(() => {
      timedOut = true;
      conn.end();
      resolve({
        success: false,
        output: "",
        errorMessage: "Connection timed out",
      });
    }, timeoutMs);

    conn.on("ready", () => {
      conn.exec(command, (err, stream) => {
        if (err) {
          clearTimeout(timer);
          conn.end();
          resolve({
            success: false,
            output: "",
            errorMessage: err.message,
          });
          return;
        }

        stream.on("close", (code: number) => {
          clearTimeout(timer);
          conn.end();
          if (!timedOut) {
            resolve({
              success: code === 0,
              output: output.trim(),
              errorMessage: code !== 0 ? (stderr.trim() || `Exit code: ${code}`) : undefined,
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
      if (!timedOut) {
        resolve({
          success: false,
          output: "",
          errorMessage: err.message,
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
        // Mikrotik SSH compatibility
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
      resolve({
        success: false,
        output: "",
        errorMessage: err.message,
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
