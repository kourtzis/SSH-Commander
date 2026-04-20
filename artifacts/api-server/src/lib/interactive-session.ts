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
  appendWireLog,
  flushWireLog,
  stripAnsi,
  stripAnsiStream,
  flushStripState,
  makeStripState,
  type StripState,
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

// ─── Script Directives ─────────────────────────────────────────────
// Operators can pause the script runner mid-execution with two tokens:
//   <<SLEEP 5>>     pause 5 (or 5.5 etc.) seconds before sending the next chunk
//   <<WAIT>>        wait until the device shell stops emitting data for 1.5s,
//                   i.e. until the previous command finished and the prompt
//                   came back. Useful between e.g. `apt update` and
//                   `apt upgrade -y` when you can't predict how long the
//                   first one takes.
// The directives must be on their own (or surrounded by whitespace/newlines).
// They are parsed out of the script before being sent to the device, so they
// never reach the wire.
type CmdSegment =
  | { kind: "text"; text: string }
  | { kind: "sleep"; ms: number }
  | { kind: "wait" };

const DIRECTIVE_RE = /<<\s*(SLEEP\s+\d+(?:\.\d+)?|WAIT)\s*>>/g;

export function parseScriptDirectives(command: string): CmdSegment[] {
  const segments: CmdSegment[] = [];
  let lastIdx = 0;
  let match: RegExpExecArray | null;
  DIRECTIVE_RE.lastIndex = 0;
  while ((match = DIRECTIVE_RE.exec(command)) !== null) {
    const before = command.slice(lastIdx, match.index);
    if (before.length > 0) segments.push({ kind: "text", text: before });
    const tok = match[1].toUpperCase().trim();
    if (tok.startsWith("SLEEP")) {
      const seconds = parseFloat(tok.split(/\s+/)[1]);
      // Clamp to a sane range — 0.1s minimum, 10min maximum per directive.
      // Operators wanting longer pauses should chain multiple <<SLEEP>>s or
      // raise the per-job timeout (currently a 120s ceiling).
      const ms = Math.max(100, Math.min(600000, Math.round(seconds * 1000)));
      segments.push({ kind: "sleep", ms });
    } else if (tok === "WAIT") {
      segments.push({ kind: "wait" });
    }
    lastIdx = match.index + match[0].length;
  }
  const tail = command.slice(lastIdx);
  if (tail.length > 0) segments.push({ kind: "text", text: tail });
  return segments;
}

// Polls the per-device shellBuffer length; resolves once the buffer hasn't
// grown for `idleMs` milliseconds (i.e. the device has finished talking and
// is presumably back at the prompt). Bounded by `maxWaitMs` so a stuck device
// can't hold the script forever — in that case we resolve anyway and let the
// next segment be sent.
function waitForShellIdle(
  dev: { shellBuffer: string; resolved: boolean },
  idleMs: number,
  maxWaitMs: number,
): Promise<void> {
  return new Promise(resolve => {
    let lastSize = dev.shellBuffer.length;
    let lastChange = Date.now();
    const start = Date.now();
    const tick = setInterval(() => {
      if (dev.resolved) { clearInterval(tick); resolve(); return; }
      if (dev.shellBuffer.length !== lastSize) {
        lastSize = dev.shellBuffer.length;
        lastChange = Date.now();
      }
      const idleEnough = Date.now() - lastChange >= idleMs;
      const timedOut = Date.now() - start >= maxWaitMs;
      if (idleEnough || timedOut) { clearInterval(tick); resolve(); }
    }, 250);
  });
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
    tasks: { id: number; routerId: number }[],
    // Per-job global timeout in seconds. The interactive runner used to
    // hardcode 120s, which clipped any script using long <<SLEEP>>/<<WAIT>>
    // pauses. Now respects the value the operator picked on the New Job
    // page; fall back to 120 if not provided so legacy callers behave as
    // before.
    timeoutSeconds: number = 120
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
      this.connectDevice(jobId, task.id, { ...r, sshUsername: creds.username, sshPassword: creds.password, jumpHost: creds.jumpHost }, finalScript, autoConfirm, timeoutSeconds);
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
    autoConfirm: boolean,
    timeoutSeconds: number = 120
  ): void {
    const job = this.jobs.get(jobId);
    if (!job) return;

    const conn = new Client();
    const log: string[] = [];
    // Per-device global timeout. Honors the per-job value chosen on the New
    // Job page; clamped to 5s..2h for sanity.
    const timeoutMs = Math.max(5_000, Math.min(7_200_000, timeoutSeconds * 1000));

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

      // Pass an explicit PTY config so devices like MikroTik RouterOS don't
      // fire terminal-size-probing escape sequences (\x1b[999;999H\x1b[6n)
      // and then *block* waiting for a Device Status Report reply. With
      // explicit rows/cols/term most devices skip the probe entirely. The
      // <<DSR_RESPONDER>> handler below is a belt-and-braces fallback in
      // case a device probes anyway. cols=200 avoids RouterOS auto-wrapping
      // long output lines.
      conn.shell({ rows: 24, cols: 200, term: "vt100" }, (err, stream) => {
        if (err) {
          log.push(`[${ts()}] ERROR: shell failed — ${err.message}`);
          this.finalizeDevice(jobId, taskId, false, err.message);
          return;
        }

        dev.stream = stream;

        // Per-direction line buffers so partial chunks don't show as
        // truncated/duplicated lines in the wire log. See `appendWireLog`
        // in ssh.ts for the full rationale.
        let recvBuf = "";
        let stderrBuf = "";
        // Stream-aware ANSI stripper state. SSH chunks can split a single
        // escape sequence (e.g. `\x1b[6n`) across two TCP frames; without
        // state, the lone trailing `\x1b` of frame A gets eaten by the C0
        // control-char rule and `[6n` arrives in frame B with nothing to
        // anchor on, leaking to the UI as visible junk. stripState carries
        // any trailing partial escape over to the next chunk.
        const stripState: StripState = makeStripState();

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
          flushWireLog(log, recvBuf, "<<");  recvBuf = "";
          flushWireLog(log, stderrBuf, "<<E"); stderrBuf = "";
          // Drain any partial-escape bytes still held by the stream stripper
          // — emit them as a final SSE chunk so the user sees the very last
          // line of output (typically a prompt).
          const tail = flushStripState(stripState);
          if (tail) {
            job.emitter.emit("event", {
              type: "task_output",
              taskId,
              routerId: router.id,
              routerName: router.name,
              routerIp: router.ipAddress,
              output: tail,
            } as LiveEvent);
          }
          if (!dev.resolved) {
            log.push(`[${ts()}] ──────────────────────────────────`);
            log.push(`[${ts()}] Shell session closed by remote`);
            this.finalizeDevice(jobId, taskId, true);
          }
        });

        stream.on("data", (data: Buffer) => {
          const chunk = data.toString();
          dev.shellBuffer += chunk;
          recvBuf = appendWireLog(log, recvBuf, "<<", chunk);
          resetIdleTimer();

          // Stream output to SSE subscribers in real-time. Strip ANSI/control
          // bytes so the live "Output" pane stays readable — raw bytes still
          // go to the wire log via appendWireLog above for debugging. Use the
          // stateful stripper so escape sequences split across TCP chunk
          // boundaries are reassembled before stripping, instead of leaking
          // their tail (e.g. `[6n`, `[9999B`) to the UI.
          const cleanChunk = stripAnsiStream(stripState, chunk);
          if (cleanChunk) {
            job.emitter.emit("event", {
              type: "task_output",
              taskId,
              routerId: router.id,
              routerName: router.name,
              routerIp: router.ipAddress,
              output: cleanChunk,
            } as LiveEvent);
          }

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
          stderrBuf = appendWireLog(log, stderrBuf, "<<E", chunk);
        });

        // ─── Wait for shell prompt before sending the script ────────
        // We used to fire the script after a flat 500ms wait. That was fine
        // for fast Linux boxes but caused a real race on chatty devices —
        // MikroTik RouterOS, Cisco IOS, anything behind RADIUS — where the
        // shell needs several seconds to print its banner and emit the
        // first prompt. Sending the script before the prompt arrived meant
        // the first command was either dropped entirely or interpreted as
        // garbage by the still-initializing shell.
        //
        // Instead we now poll dev.shellBuffer for a "prompt-shaped" tail
        // (a typical CLI prompt char like > # $ % ] : possibly followed by
        // whitespace, at the very end of the buffer with no trailing
        // newline). We strip ANSI before matching since chatty devices wrap
        // their prompts in color codes. A 20s ceiling guarantees we always
        // try to send eventually — if a device never shows a recognisable
        // prompt we fall through and let the script run anyway, with a log
        // entry so operators know what happened.
        const PROMPT_RE = /(?:^|\n)[^\n]*[>#$%\]:][ \t]*$/;
        const PROMPT_CEILING_MS = 20_000;
        const PROMPT_POLL_MS = 100;
        const promptStart = Date.now();
        const waitForPrompt = (): Promise<"prompt" | "ceiling"> =>
          new Promise(resolve => {
            const tick = setInterval(() => {
              if (dev.resolved) { clearInterval(tick); resolve("ceiling"); return; }
              const cleaned = stripAnsi(dev.shellBuffer);
              if (PROMPT_RE.test(cleaned)) {
                clearInterval(tick); resolve("prompt"); return;
              }
              if (Date.now() - promptStart >= PROMPT_CEILING_MS) {
                clearInterval(tick); resolve("ceiling"); return;
              }
            }, PROMPT_POLL_MS);
          });

        log.push(`[${ts()}] Waiting for shell prompt (max ${PROMPT_CEILING_MS / 1000}s)`);
        waitForPrompt().then(reason => {
          if (dev.resolved) return;
          const waited = Date.now() - promptStart;
          if (reason === "prompt") {
            log.push(`[${ts()}] Shell prompt detected after ${waited}ms`);
          } else {
            log.push(`[${ts()}] No shell prompt detected after ${waited}ms — sending command anyway`);
          }

          dev.commandSent = true;
          // Log every line of the command being sent so the operator can see
          // exactly what hit the wire. Logged before the actual write so the
          // log timestamp precedes any echoed output.
          log.push(`[${ts()}] Executing command (${command.split("\n").length} line(s)):`);
          appendWireLog(log, "", ">>", command + "\n");

          // Parse for <<SLEEP N>> / <<WAIT>> directives. If none, the segments
          // array contains a single text entry and we fall through to the
          // simple single-write path. If directives are present, send each
          // segment in sequence with the requested pause/idle-wait between.
          const segments = parseScriptDirectives(command);
          const hasDirectives = segments.some(s => s.kind !== "text");

          if (!hasDirectives) {
            writeCommandWithControlChars(stream, command);
            resetIdleTimer();
            return;
          }

          // Sequenced execution. Async IIFE so we can await sleeps/idles.
          // We pause the idle timer during sleep/wait so the session doesn't
          // self-terminate mid-script. The global timeout (`timeoutMs`) still
          // applies — operators using long sleeps must set the job's timeout
          // accordingly via the New Job page.
          (async () => {
            for (const seg of segments) {
              if (dev.resolved) return;
              if (seg.kind === "text") {
                if (seg.text.length === 0) continue;
                // Each text segment ends with an explicit newline so the
                // shell executes the buffered command before we move on.
                writeCommandWithControlChars(stream, seg.text, true);
                resetIdleTimer();
              } else if (seg.kind === "sleep") {
                log.push(`[${ts()}] Pausing ${(seg.ms / 1000).toFixed(1)}s before next segment (<<SLEEP>>)`);
                if (dev.idleTimerRef) { clearTimeout(dev.idleTimerRef); dev.idleTimerRef = null; }
                await new Promise(r => setTimeout(r, seg.ms));
                if (dev.resolved) return;
                resetIdleTimer();
              } else if (seg.kind === "wait") {
                log.push(`[${ts()}] Waiting for shell to go idle (<<WAIT>>)`);
                if (dev.idleTimerRef) { clearTimeout(dev.idleTimerRef); dev.idleTimerRef = null; }
                await waitForShellIdle(dev, 1500, Math.max(timeoutMs - 5000, 30000));
                if (dev.resolved) return;
                log.push(`[${ts()}] Shell idle, resuming script`);
                resetIdleTimer();
              }
            }
          })().catch(err => {
            log.push(`[${ts()}] ERROR during sequenced send: ${err?.message ?? err}`);
            this.finalizeDevice(jobId, taskId, false, "sequenced-send error");
          });
        }).catch(err => {
          log.push(`[${ts()}] ERROR while waiting for shell prompt: ${err?.message ?? err}`);
          this.finalizeDevice(jobId, taskId, false, "prompt-wait error");
        });
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
      output: stripAnsi(dev.shellBuffer).trim() || null,
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
