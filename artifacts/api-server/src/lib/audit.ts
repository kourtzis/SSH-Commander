// ─── Audit trail helper ─────────────────────────────────────────────
// One call per state-changing action. Deliberately fire-and-forget in
// spirit: an audit INSERT failure must never break the action being
// audited, so every path swallows and logs its own errors.
//
// Action naming convention: dot-namespaced "<resource>.<verb>" —
// "auth.login", "auth.login_failed", "router.create", "job.run",
// "backup.run", "upgrade.start", "token.create", "user.reset_totp", ...

import type { Request } from "express";
import { db, auditLogTable } from "@workspace/db";
import { getCurrentUser } from "./auth.js";
import { childLogger } from "./logger.js";

const log = childLogger("audit");

export interface AuditOpts {
  resourceType?: string;
  resourceId?: string | number;
  resourceName?: string;
  details?: Record<string, unknown>;
}

/** Audit an action performed by the requester (session or API token). */
export async function logAudit(req: Request, action: string, opts: AuditOpts = {}): Promise<void> {
  try {
    const user = await getCurrentUser(req);
    await db.insert(auditLogTable).values({
      userId: user?.id ?? null,
      username: user?.username ?? "unknown",
      action,
      resourceType: opts.resourceType ?? null,
      resourceId: opts.resourceId !== undefined ? String(opts.resourceId) : null,
      resourceName: opts.resourceName ?? null,
      details: opts.details ?? null,
      ip: req.ip ?? null,
    });
  } catch (err) {
    log.warn({ err, action }, "audit write failed");
  }
}

/** Audit an action with an explicit actor (login flows, where the session isn't established yet). */
export async function logAuditAs(
  req: Request,
  actor: { id: number | null; username: string },
  action: string,
  opts: AuditOpts = {},
): Promise<void> {
  try {
    await db.insert(auditLogTable).values({
      userId: actor.id,
      username: actor.username,
      action,
      resourceType: opts.resourceType ?? null,
      resourceId: opts.resourceId !== undefined ? String(opts.resourceId) : null,
      resourceName: opts.resourceName ?? null,
      details: opts.details ?? null,
      ip: req.ip ?? null,
    });
  } catch (err) {
    log.warn({ err, action }, "audit write failed");
  }
}

/** Audit a background/system action (scheduler, maintenance loops). */
export async function logAuditSystem(action: string, opts: AuditOpts = {}): Promise<void> {
  try {
    await db.insert(auditLogTable).values({
      userId: null,
      username: "system",
      action,
      resourceType: opts.resourceType ?? null,
      resourceId: opts.resourceId !== undefined ? String(opts.resourceId) : null,
      resourceName: opts.resourceName ?? null,
      details: opts.details ?? null,
      ip: null,
    });
  } catch (err) {
    log.warn({ err, action }, "audit write failed");
  }
}
