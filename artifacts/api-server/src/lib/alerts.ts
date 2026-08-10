// ─── Alert dispatcher ───────────────────────────────────────────────
// emitAlert() is the single entry point every subsystem calls when
// something noteworthy happens. It never throws and never blocks the
// caller on network I/O beyond its own awaited sends — call sites that
// must not wait can fire-and-forget (`void emitAlert(...)`).
//
// Flow: match enabled rules on event type → apply router/group scoping →
// cooldown suppression → deliver to each configured channel → record one
// alert_events row per matched rule.

import nodemailer from "nodemailer";
import {
  db,
  alertRulesTable,
  alertEventsTable,
  notificationChannelsTable,
  decryptSecret,
} from "@workspace/db";
import { eq, inArray } from "drizzle-orm";
import { resolveRouterIds } from "./resolve-routers.js";
import { childLogger } from "./logger.js";

const log = childLogger("alerts");

export type AlertEventType =
  | "device_down"
  | "device_up"
  | "job_failed"
  | "job_completed"
  | "schedule_failed"
  | "backup_failed"
  | "drift_detected"
  | "upgrade_completed"
  | "upgrade_failed";

export interface AlertContext {
  subject: string;
  message: string;
  /** For device-centric events: lets rules scoped to routers/groups filter. */
  routerId?: number;
  /** Cooldown identity — e.g. "router:12", "golden:3", "job:55". Defaults to the event type alone. */
  entityKey?: string;
}

// ─── Cooldown state (in-memory, per process) ────────────────────────
const lastFired = new Map<string, number>();

function pruneCooldowns(): void {
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  for (const [k, t] of lastFired) {
    if (t < cutoff) lastFired.delete(k);
  }
}
setInterval(pruneCooldowns, 60 * 60 * 1000).unref();

// ─── Channel senders ────────────────────────────────────────────────

interface ChannelRow {
  id: number;
  name: string;
  type: "telegram" | "email" | "webhook";
  config: string;
  enabled: boolean;
}

function parseChannelConfig(row: ChannelRow): Record<string, unknown> {
  const raw = decryptSecret(row.config) ?? row.config;
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    throw new Error("Channel config is corrupted (not valid JSON)");
  }
}

async function sendTelegram(cfg: Record<string, unknown>, subject: string, message: string): Promise<void> {
  const botToken = String(cfg.botToken ?? "");
  const chatId = String(cfg.chatId ?? "");
  if (!botToken || !chatId) throw new Error("Telegram channel is missing botToken or chatId");
  const resp = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text: `${subject}\n\n${message}` }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new Error(`Telegram API ${resp.status}: ${body.slice(0, 200)}`);
  }
}

async function sendWebhook(cfg: Record<string, unknown>, eventType: string, subject: string, message: string): Promise<void> {
  const url = String(cfg.url ?? "");
  if (!url) throw new Error("Webhook channel is missing url");
  const payload = JSON.stringify({
    event: eventType,
    subject,
    message,
    timestamp: new Date().toISOString(),
    source: "ssh-commander",
  });
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const secret = String(cfg.secret ?? "");
  if (secret) {
    const { createHmac } = await import("crypto");
    headers["X-SSHC-Signature"] = createHmac("sha256", secret).update(payload).digest("hex");
  }
  const resp = await fetch(url, { method: "POST", headers, body: payload, signal: AbortSignal.timeout(10_000) });
  if (!resp.ok) throw new Error(`Webhook responded ${resp.status}`);
}

async function sendEmail(cfg: Record<string, unknown>, subject: string, message: string): Promise<void> {
  const host = String(cfg.host ?? "");
  const port = Number(cfg.port ?? 587);
  const to = String(cfg.to ?? "");
  const from = String(cfg.from ?? cfg.username ?? "ssh-commander@localhost");
  if (!host || !to) throw new Error("Email channel is missing host or to");
  const username = String(cfg.username ?? "");
  const password = String(cfg.password ?? "");
  const transport = nodemailer.createTransport({
    host,
    port,
    secure: Boolean(cfg.secure ?? port === 465),
    auth: username ? { user: username, pass: password } : undefined,
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 15_000,
  });
  try {
    await transport.sendMail({ from, to, subject: `[SSH Commander] ${subject}`, text: message });
  } finally {
    transport.close();
  }
}

/** Deliver to one channel. Throws with a human-readable reason on failure. */
export async function deliverToChannel(
  row: ChannelRow,
  eventType: string,
  subject: string,
  message: string,
): Promise<void> {
  const cfg = parseChannelConfig(row);
  if (row.type === "telegram") return sendTelegram(cfg, subject, message);
  if (row.type === "webhook") return sendWebhook(cfg, eventType, subject, message);
  if (row.type === "email") return sendEmail(cfg, subject, message);
  throw new Error(`Unknown channel type: ${row.type}`);
}

// ─── Rule matching + emit ───────────────────────────────────────────

async function ruleMatchesScope(rule: { routerIds: number[]; groupIds: number[] }, routerId: number | undefined): Promise<boolean> {
  const hasScope = (rule.routerIds?.length ?? 0) > 0 || (rule.groupIds?.length ?? 0) > 0;
  if (!hasScope) return true;       // unscoped rule → all devices
  if (routerId === undefined) return true; // non-device event → scope does not apply
  if (rule.routerIds?.includes(routerId)) return true;
  if ((rule.groupIds?.length ?? 0) > 0) {
    try {
      const members = await resolveRouterIds([], rule.groupIds);
      if (members.includes(routerId)) return true;
    } catch (err) {
      log.warn({ err }, "group scope resolution failed — treating as non-matching");
    }
  }
  return false;
}

export async function emitAlert(eventType: AlertEventType, ctx: AlertContext): Promise<void> {
  try {
    const rules = await db.select().from(alertRulesTable).where(eq(alertRulesTable.enabled, true));
    const matching = rules.filter((r) => (r.eventTypes ?? []).includes(eventType));
    if (matching.length === 0) return;

    for (const rule of matching) {
      try {
        if (!(await ruleMatchesScope(rule, ctx.routerId))) continue;

        const cooldownKey = `${rule.id}:${eventType}:${ctx.entityKey ?? "-"}`;
        const cooldownMs = Math.max(0, rule.cooldownMinutes) * 60_000;
        const last = lastFired.get(cooldownKey) ?? 0;
        if (cooldownMs > 0 && Date.now() - last < cooldownMs) {
          await db.insert(alertEventsTable).values({
            ruleId: rule.id,
            ruleName: rule.name,
            eventType,
            subject: ctx.subject,
            message: ctx.message,
            status: "suppressed",
            error: null,
          });
          continue;
        }
        lastFired.set(cooldownKey, Date.now());

        const channels = (rule.channelIds?.length ?? 0) > 0
          ? await db.select().from(notificationChannelsTable).where(inArray(notificationChannelsTable.id, rule.channelIds))
          : [];

        const errors: string[] = [];
        let sentCount = 0;
        for (const ch of channels) {
          if (!ch.enabled) continue;
          try {
            await deliverToChannel(ch, eventType, ctx.subject, ctx.message);
            sentCount++;
            await db.update(notificationChannelsTable)
              .set({ lastUsedAt: new Date(), lastError: null })
              .where(eq(notificationChannelsTable.id, ch.id));
          } catch (err: any) {
            const reason = err?.message ?? String(err);
            errors.push(`${ch.name}: ${reason}`);
            await db.update(notificationChannelsTable)
              .set({ lastUsedAt: new Date(), lastError: reason })
              .where(eq(notificationChannelsTable.id, ch.id));
          }
        }

        await db.insert(alertEventsTable).values({
          ruleId: rule.id,
          ruleName: rule.name,
          eventType,
          subject: ctx.subject,
          message: ctx.message,
          status: errors.length > 0 ? "failed" : "sent",
          error: errors.length > 0 ? errors.join("; ") : sentCount === 0 ? "No enabled channels" : null,
        });
      } catch (err) {
        log.warn({ err, rule: rule.name }, "alert rule processing failed");
      }
    }
  } catch (err) {
    log.warn({ err, eventType }, "emitAlert failed");
  }
}
