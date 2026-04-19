// ─── Interactive SSH Session Manager ────────────────────────────────
// Manages parallel SSH sessions for interactive (non-auto-confirm) jobs.
// Each router gets its own SSH shell connection. When a prompt is detected
// (y/n or input), the session pauses and emits an SSE event so the UI can
// show the prompt and collect user input. The user's response is then
// forwarded to the SSH stream.
//
// All sessions for a job share a single EventEmitter, which the SSE
// endpoint (/jobs/:id/live) subscribes to for real-time updates.

import { Client, type ClientChannel } from "ssh2";
import { EventEmitter } from "events";
import { db, jobTasksTable, batchJobsTable } from "@workspace/db";
import { eq, and, inArray } from "drizzle-orm";
import {
  SSH_ALGORITHMS,
  looksLikeConfirmPrompt,
  detectPromptType,
  extractPromptText,
  applyTagSubstitution,
  writeCommandWithControlChars,
  makeHostKeyVerifier,
  connectViaJumpHost,
} from "./ssh.js";
import { resolveEffectiveCreds } from "./effective-creds.js";

// Event types emitted via SSE to the frontend
export interface LiveEvent {
  type:
    | "task_status"     // Task changed state (running/success/failed)
    | "task_output"     // New SSH output chunk received
    | "input_required"  // Prompt detected — waiting for user input
    | "input_sent"      // User's input was forwarded to the SSH stream
    | "job_complete";   // All tasks finished
  taskId: number;
  routerId?: number;
  routerName?: string;
  routerIp?: string;
  status?: string;
  output?: string;
  promptText?: string;
  promptType?: "confirm" | "input";
  input?: string;
  jobStatus?: string;
  completedTasks?: number;
  failedTasks?: number;
  totalTasks?: number;
}

// Per-device SSH session state
interface DeviceSession {
  taskId: number;
  routerId: number;
  routerName: string;
  routerIp: string;
  conn: Client;                    // ssh2 connection instance
  stream: ClientChannel | null;    // Shell stream (set after shell opens)
  shellBuffer: string;             // Accumulated SSH output
  log: string[];                   // Timestamped connection log entries
  state: "connecting" | "running" | "waiting_input" | "completed" | "failed";
  promptText: string | null;       // Current prompt text (while waiting for input)
  promptType: "confirm" | "input" | null;
  lastPromptChecked: string;       // Deduplication: last 200 chars checked for prompts
  autoConfirmCount: number;        // How many prompts were auto-confirmed (if applicable)
  commandSent: boolean;            // Whether the command has been sent (delayed by 500ms)
  idleTimerRef: ReturnType<typeof setTimeout> | null;    // Idle timer (closes session on inactivity)
  globalTimerRef: ReturnType<typeof setTimeout> | null;  // Global timeout (hard limit per device)
  resolved: boolean;               // True once the device session is finalized
}

// Aggregated state for an entire job's interactive execution
interface JobSession {
  jobId: number;
  autoConfirm: boolean;
  devices: Map<number, DeviceSession>;  // Keyed by taskId
  emitter: EventEmitter;                // SSE event bus
  totalTasks: number;
  completedCount: number;
  failedCount: number;
}

// Timestamp helper for connection logs
function ts(): string {
  return new Date().toISOString().replace("T", " ").replace("Z", "");
}

class InteractiveSessionManager {
  private jobs = new Map<number, JobSession>();

  // Get the SSE event emitter for a job (used by the /live endpoint)
  getJobEmitter(jobId: number): EventEmitter | null {
    return this.jobs.get(jobId)?.emitter ?? null;
  }

  hasJob(jobId: number): boolean {
    return this.jobs.has(jobId);
  }

  // Return all tasks currently waiting for user input (sent to SSE on reconnect)
  getWaitingTasks(jobId: number): { taskId: number; routerId: number; routerName: string; routerIp: string; promptText: string; promptType: string }[] {
    const job = this.jobs.get(jobId);
    if (!job) return [];
    const results: any[] = [];
    for (const dev of job.devices.values()) {
      if (dev.state === "waiting_input") {
        results.push({
          taskId: dev.taskId,
          routerId: dev.routerId,
          routerName: dev.routerName,
          routerIp: dev.routerIp,
          promptText: dev.promptText ?? "",
          promptType: dev.promptType ?? "input",
        });
      }
    }
    return results;
  }

  // Forward user input to one or more waiting SSH sessions
  async sendInput(jobId: number, taskIds: number[], input: string): Promise<{ sent: number[]; notFound: number[] }> {
    const job = this.jobs.get(jobId);
    if (!job) return { sent: [], notFound: taskIds };

    const sent: number[] = [];
    const notFound: number[] = [];

    for (const taskId of taskIds) {
      const dev = job.devices.get(taskId);
      if (!dev || dev.state !== "waiting_input" || !dev.stream) {
        notFound.push(taskId);
        continue;
      }

      // Write the user's response to the SSH stream
      dev.stream.write(input + "\n");
      dev.log.push(`[${ts()}] User input sent: "${input}"`);
      dev.state = "running";
      dev.promptText = null;
      dev.promptType = null;
      sent.push(taskId);

      await db.update(jobTasksTable)
        .set({ status: "running", promptText: null })
        .where(eq(jobTasksTable.id, taskId));

      // Reset idle timer — give the device 5s to produce more output
      dev.idleTimerRef = setTimeout(() => {
        this.handleDeviceIdle(jobId, taskId);
      }, 5000);

      job.emitter.emit("event", {
        type: "input_sent",
        taskId,
        routerId: dev.routerId,
        routerName: dev.routerName,
        routerIp: dev.routerIp,
        input,
        status: "running",
      } as LiveEvent);
    }

    return { sent, notFound };
  }

  // Launch parallel interactive SSH sessions for all routers in a job.
  // Each device connects independently. All emit events through the shared emitter.
  async startInteractiveJob(
    jobId: number,
    routers: { id: number; name: string; ipAddress: string; sshPort: number; sshUsername: string; sshPassword: string | null; enablePassword?: string | null; credentialProfileId?: number | null; sshHostKeyFingerprint?: string | null }[],
    scriptCode: string,
    excelData: Record<string, string>[] | undefined,
    autoConfirm: boolean,
    tasks: { id: number; routerId: number }[]
  ): Promise<void> {
    const emitter = new EventEmitter();
    emitter.setMaxListeners(50);

    const jobSession: JobSession = {
      jobId,
      autoConfirm,
      devices: new Map(),
      emitter,
      totalTasks: routers.length,
      completedCount: 0,
      failedCount: 0,
    };

    this.jobs.set(jobId, jobSession);

    // Build Excel lookup for variable substitution
    const excelLookup = this.buildExcelLookup(excelData);

    // Connect all routers in parallel
    const promises = routers.map(async (r, i) => {
      const task = tasks.find(t => t.routerId === r.id);
      if (!task) return;

      // Apply {{TAG}} substitution from the Excel data
      const row = this.findExcelRow(r, excelLookup, i, excelData);
      const finalScript = applyTagSubstitution(scriptCode, row);

      // Store the resolved script for display in the UI
      await db.update(jobTasksTable)
        .set({ resolvedScript: finalScript })
        .where(eq(jobTasksTable.id, task.id));

      // Resolve effective creds (credential profile + bastion). We pass
      // through the resolved values so connectDevice doesn't need to hit
      // the DB again for every device.
      const creds = await resolveEffectiveCreds(r as any);

      // Handle missing password upfront
      if (!creds.password) {
        const noPassLog = [
          `[${ts()}] SSH session initiated`,
          `[${ts()}] Target: ${creds.username || r.sshUsername}@${r.ipAddress}:${r.sshPort}`,
          `[${ts()}] ERROR: No SSH password configured (check the credential profile or set an inline password)`,
          `[${ts()}] Session aborted`,
        ].join("\n");
        await db.update(jobTasksTable)
          .set({ status: "failed", errorMessage: "No SSH password configured", connectionLog: noPassLog, completedAt: new Date() })
          .where(eq(jobTasksTable.id, task.id));
        jobSession.failedCount++;
        emitter.emit("event", { type: "task_status", taskId: task.id, routerId: r.id, routerName: r.name, routerIp: r.ipAddress, status: "failed" } as LiveEvent);
        this.checkJobComplete(jobId);
        return;
      }

      // Mark task as running
      await db.update(jobTasksTable)
        .set({ status: "running", startedAt: new Date() })
        .where(eq(jobTasksTable.id, task.id));

      emitter.emit("event", { type: "task_status", taskId: task.id, routerId: r.id, routerName: r.name, routerIp: r.ipAddress, status: "running" } as LiveEvent);

      // Start the SSH connection for this device using resolved creds
      this.connectDevice(jobId, task.id, { ...r, sshUsername: creds.username, sshPassword: creds.password, jumpHost: creds.jumpHost }, finalScript, autoConfirm);
    });

    await Promise.all(promises);
  }

  // ─── Per-Device SSH Connection ──────────────────────────────────
  // Opens an interactive shell to one router, sends the command,
  // and watches for prompts. Emits SSE events as output arrives.
  private connectDevice(
    jobId: number,
    taskId: number,
    router: { id: number; name: string; ipAddress: string; sshPort: number; sshUsername: string; sshPassword: string | null; sshHostKeyFingerprint?: string | null; jumpHost?: { host: string; port: number; username: string; password: string } },
    command: string,
    autoConfirm: boolean
  ): void {
    const job = this.jobs.get(jobId);
    if (!job) return;

    const conn = new Client();
    const log: string[] = [];
    const timeoutMs = 120000;  // 2 minute hard limit per device

    const dev: DeviceSession = {
      taskId,
      routerId: router.id,
      routerName: router.name,
      routerIp: router.ipAddress,
      conn,
      stream: null,
      shellBuffer: "",
      log,
      state: "connecting",
      promptText: null,
      promptType: null,
      lastPromptChecked: "",
      autoConfirmCount: 0,
      commandSent: false,
      idleTimerRef: null,
      globalTimerRef: null,
      resolved: false,
    };

    job.devices.set(taskId, dev);

    // Build connection log header
    log.push(`[${ts()}] SSH session initiated`);
    log.push(`[${ts()}] Target: ${router.sshUsername}@${router.ipAddress}:${router.sshPort}`);
    log.push(`[${ts()}] Mode: interactive shell`);
    log.push(`[${ts()}] Auto-confirm: ${autoConfirm ? "enabled" : "disabled"}`);
    log.push(`[${ts()}] Connecting...`);

    // Global timeout — hard-kills the connection after 2 minutes
    dev.globalTimerRef = setTimeout(() => {
      if (dev.resolved) return;
      log.push(`[${ts()}] ERROR: Global timeout after ${timeoutMs}ms`);
      this.finalizeDevice(jobId, taskId, false, "Global timeout exceeded");
    }, timeoutMs);

    conn.on("handshake", (negotiated) => {
      log.push(`[${ts()}] Handshake complete`);
      log.push(`[${ts()}]   KEX: ${negotiated.kex}`);
      log.push(`[${ts()}]   Cipher (C→S): ${negotiated.cs.cipher}`);
      log.push(`[${ts()}]   Server host key: ${negotiated.serverHostKey}`);
    });

    conn.on("ready", () => {
      log.push(`[${ts()}] Authentication successful`);
      log.push(`[${ts()}] Opening interactive shell...`);
      log.push(`[${ts()}] ──────────────────────────────────`);
      dev.state = "running";

      conn.shell((err, stream) => {
        if (err) {
          log.push(`[${ts()}] ERROR: shell failed — ${err.message}`);
          this.finalizeDevice(jobId, taskId, false, err.message);
          return;
        }

        dev.stream = stream;

        // Idle timer: if no new data for 5s, check for prompts or close
        const resetIdleTimer = () => {
          if (dev.idleTimerRef) clearTimeout(dev.idleTimerRef);
          dev.idleTimerRef = setTimeout(() => {
            if (dev.state === "waiting_input" || dev.resolved) return;
            if (dev.commandSent) {
              const pType = detectPromptType(dev.shellBuffer);
              if (pType && !autoConfirm) {
                this.handlePromptDetected(jobId, taskId, pType);
              } else if (pType && autoConfirm && pType === "confirm") {
                // Already handled inline in the data event
              } else {
                log.push(`[${ts()}] Shell idle — closing session`);
                this.finalizeDevice(jobId, taskId, true);
              }
            }
          }, 5000);
        };

        stream.on("close", () => {
          if (!dev.resolved) {
            log.push(`[${ts()}] ──────────────────────────────────`);
            log.push(`[${ts()}] Shell session closed by remote`);
            this.finalizeDevice(jobId, taskId, true);
          }
        });

        stream.on("data", (data: Buffer) => {
          const chunk = data.toString();
          dev.shellBuffer += chunk;
          resetIdleTimer();

          // Stream output to SSE subscribers in real-time
          job.emitter.emit("event", {
            type: "task_output",
            taskId,
            routerId: router.id,
            routerName: router.name,
            routerIp: router.ipAddress,
            output: chunk,
          } as LiveEvent);

          if (!dev.commandSent) return;

          // Check for interactive prompts in the latest output
          const currentTail = dev.shellBuffer.slice(-200);
          if (currentTail === dev.lastPromptChecked) return;

          const promptType = detectPromptType(dev.shellBuffer);
          if (promptType === "confirm") {
            if (autoConfirm) {
              dev.lastPromptChecked = currentTail;
              dev.autoConfirmCount++;
              log.push(`[${ts()}] Auto-confirm #${dev.autoConfirmCount}: detected prompt, sending "y"`);
              stream.write("y\n");
            } else {
              dev.lastPromptChecked = currentTail;
              this.handlePromptDetected(jobId, taskId, "confirm");
            }
          } else if (promptType === "input") {
            dev.lastPromptChecked = currentTail;
            this.handlePromptDetected(jobId, taskId, "input");
          }
        });

        stream.stderr.on("data", (data: Buffer) => {
          const chunk = data.toString();
          dev.shellBuffer += chunk;
        });

        // Delay command send to let shell banner/MOTD arrive first
        setTimeout(() => {
          dev.commandSent = true;
          writeCommandWithControlChars(stream, command);
          resetIdleTimer();
        }, 500);
      });
    });

    conn.on("error", (err) => {
      log.push(`[${ts()}] ERROR: ${err.message}`);
      this.finalizeDevice(jobId, taskId, false, err.message);
    });

    try {
      if (router.jumpHost) {
        // Bastion path. connectViaJumpHost returns a fully authenticated
        // Client; we then attach the same handlers we'd use for a direct
        // connection by re-emitting the "ready" event ourselves so the
        // shell-open code path runs identically.
        log.push(`[${ts()}] Routing through jump host ${router.jumpHost.username}@${router.jumpHost.host}:${router.jumpHost.port}`);
        connectViaJumpHost(
          {
            host: router.ipAddress,
            port: router.sshPort,
            username: router.sshUsername,
            password: router.sshPassword!,
            hostKeyTrust: { routerId: router.id, expectedFingerprint: router.sshHostKeyFingerprint ?? null },
          },
          router.jumpHost,
          30000,
          log,
        ).then((readyConn) => {
          // Swap conn references so cleanup paths still close the real one.
          dev.conn = readyConn;
          readyConn.on("error", (err) => {
            log.push(`[${ts()}] ERROR: ${err.message}`);
            this.finalizeDevice(jobId, taskId, false, err.message);
          });
          // Manually trigger the "ready" handler we pre-attached to the
          // original placeholder — it knows how to open the shell.
          readyConn.emit("ready");
        }).catch((err: any) => {
          log.push(`[${ts()}] ERROR: jump host connect failed — ${err.message}`);
          this.finalizeDevice(jobId, taskId, false, err.message);
        });
      } else {
        const cfg: any = {
          host: router.ipAddress,
          port: router.sshPort,
          username: router.sshUsername,
          password: router.sshPassword!,
          readyTimeout: 30000,
          algorithms: SSH_ALGORITHMS,
        };
        cfg.hostVerifier = makeHostKeyVerifier(
          { routerId: router.id, expectedFingerprint: router.sshHostKeyFingerprint ?? null },
          (presented, expected) => {
            log.push(`[${ts()}] ERROR: Host key MISMATCH for ${router.ipAddress} (presented ${presented}, expected ${expected})`);
          },
        );
        conn.connect(cfg);
      }
    } catch (err: any) {
      log.push(`[${ts()}] ERROR: Failed to initiate — ${err.message}`);
      this.finalizeDevice(jobId, taskId, false, err.message);
    }
  }

  // Pause execution and emit an SSE event to request user input
  private async handlePromptDetected(jobId: number, taskId: number, promptType: "confirm" | "input"): Promise<void> {
    const job = this.jobs.get(jobId);
    const dev = job?.devices.get(taskId);
    if (!dev || dev.resolved || dev.state === "waiting_input") return;

    if (dev.idleTimerRef) clearTimeout(dev.idleTimerRef);

    const prompt = extractPromptText(dev.shellBuffer);
    dev.state = "waiting_input";
    dev.promptText = prompt;
    dev.promptType = promptType;

    dev.log.push(`[${ts()}] Prompt detected (${promptType}): waiting for user input`);

    await db.update(jobTasksTable)
      .set({ status: "waiting_input", promptText: prompt })
      .where(eq(jobTasksTable.id, taskId));

    job!.emitter.emit("event", {
      type: "input_required",
      taskId,
      routerId: dev.routerId,
      routerName: dev.routerName,
      routerIp: dev.routerIp,
      promptText: prompt,
      promptType,
      status: "waiting_input",
    } as LiveEvent);
  }

  // Mark a device session as complete/failed, clean up timers, and update the DB
  private async finalizeDevice(jobId: number, taskId: number, success: boolean, errorMessage?: string): Promise<void> {
    const job = this.jobs.get(jobId);
    const dev = job?.devices.get(taskId);
    if (!dev || dev.resolved) return;

    dev.resolved = true;
    dev.state = success ? "completed" : "failed";

    // Clear all timers
    if (dev.idleTimerRef) clearTimeout(dev.idleTimerRef);
    if (dev.globalTimerRef) clearTimeout(dev.globalTimerRef);

    if (dev.autoConfirmCount > 0) {
      dev.log.push(`[${ts()}] Auto-confirmed ${dev.autoConfirmCount} prompt(s)`);
    }
    dev.log.push(`[${ts()}] Session closed`);

    try { dev.conn.end(); } catch {}

    // Persist final task state to the database
    const dbUpdate: any = {
      status: success ? "success" : "failed",
      output: dev.shellBuffer.trim() || null,
      connectionLog: dev.log.join("\n"),
      completedAt: new Date(),
      promptText: null,
    };
    if (errorMessage) dbUpdate.errorMessage = errorMessage;

    await db.update(jobTasksTable)
      .set(dbUpdate)
      .where(eq(jobTasksTable.id, taskId));

    // Update running totals on the parent job
    if (success) job!.completedCount++;
    else job!.failedCount++;

    await db.update(batchJobsTable)
      .set({ completedTasks: job!.completedCount, failedTasks: job!.failedCount })
      .where(eq(batchJobsTable.id, jobId));

    // Emit status change to SSE subscribers
    job!.emitter.emit("event", {
      type: "task_status",
      taskId,
      routerId: dev.routerId,
      routerName: dev.routerName,
      routerIp: dev.routerIp,
      status: success ? "success" : "failed",
    } as LiveEvent);

    this.checkJobComplete(jobId);
  }

  // Check if all tasks are done — if so, finalize the job and emit job_complete
  private async checkJobComplete(jobId: number): Promise<void> {
    const job = this.jobs.get(jobId);
    if (!job) return;

    const done = job.completedCount + job.failedCount;
    if (done < job.totalTasks) return;

    // "failed" only if every single task failed
    const jobStatus = job.failedCount === job.totalTasks ? "failed" : "completed";

    await db.update(batchJobsTable)
      .set({
        status: jobStatus as any,
        completedTasks: job.completedCount,
        failedTasks: job.failedCount,
        completedAt: new Date(),
      })
      .where(eq(batchJobsTable.id, jobId));

    job.emitter.emit("event", {
      type: "job_complete",
      taskId: 0,
      jobStatus,
      completedTasks: job.completedCount,
      failedTasks: job.failedCount,
      totalTasks: job.totalTasks,
    } as LiveEvent);

    // Keep the session around for 30s so late SSE subscribers can get the final event
    setTimeout(() => {
      this.jobs.delete(jobId);
    }, 30000);
  }

  // Called when no new output arrives for 5s after user input was sent
  private handleDeviceIdle(jobId: number, taskId: number): void {
    const job = this.jobs.get(jobId);
    const dev = job?.devices.get(taskId);
    if (!dev || dev.resolved || dev.state === "waiting_input") return;

    dev.log.push(`[${ts()}] Shell idle — closing session`);
    this.finalizeDevice(jobId, taskId, true);
  }

  // Force-close all SSH sessions for a cancelled job
  async cleanupJob(jobId: number): Promise<void> {
    const job = this.jobs.get(jobId);
    if (!job) return;

    const unresolvedTaskIds: number[] = [];
    for (const [taskId, dev] of job.devices.entries()) {
      if (!dev.resolved) {
        dev.resolved = true;
        if (dev.idleTimerRef) clearTimeout(dev.idleTimerRef);
        if (dev.globalTimerRef) clearTimeout(dev.globalTimerRef);
        try { dev.conn.end(); } catch {}
        unresolvedTaskIds.push(taskId);
      }
    }

    // Batch-update all unresolved tasks to "failed"
    if (unresolvedTaskIds.length > 0) {
      await db.update(jobTasksTable)
        .set({ status: "failed", errorMessage: "Job cancelled", promptText: null, completedAt: new Date() })
        .where(inArray(jobTasksTable.id, unresolvedTaskIds));
    }

    job.emitter.emit("event", {
      type: "job_complete",
      taskId: 0,
      jobStatus: "cancelled",
      completedTasks: job.completedCount,
      failedTasks: job.failedCount + unresolvedTaskIds.length,
      totalTasks: job.totalTasks,
    } as LiveEvent);

    this.jobs.delete(jobId);
  }

  // ─── Excel Helpers (same logic as in jobs.ts) ────────────────────
  // Build a fast lookup map keyed by IP and name for O(1) row matching
  private buildExcelLookup(excelData: Record<string, string>[] | undefined): Map<string, Record<string, string>> | null {
    if (!excelData || excelData.length === 0) return null;
    const lookup = new Map<string, Record<string, string>>();
    for (const row of excelData) {
      const ip = row["ROUTER_IP"]?.trim();
      const name = row["ROUTER_NAME"]?.trim();
      if (ip) lookup.set(`ip:${ip}`, row);
      if (name) lookup.set(`name:${name.toLowerCase()}`, row);
    }
    return lookup;
  }

  // Match a router to its Excel row: try IP, then name, then positional fallback
  private findExcelRow(
    router: { name: string; ipAddress: string },
    lookup: Map<string, Record<string, string>> | null,
    index: number,
    excelData?: Record<string, string>[]
  ): Record<string, string> {
    if (lookup) {
      const byIp = lookup.get(`ip:${router.ipAddress}`);
      if (byIp) return byIp;
      const byName = lookup.get(`name:${router.name.toLowerCase()}`);
      if (byName) return byName;
    }
    if (excelData && excelData.length > 0) {
      return excelData[index] ?? excelData[excelData.length - 1];
    }
    return {};
  }
}

// Singleton instance — used by both the job routes and the SSE endpoint
export const interactiveSessions = new InteractiveSessionManager();
