// ─── API token bearer authentication ────────────────────────────────
// Mounted under /api AFTER the session middleware and BEFORE the CSRF
// check. Requests carrying `Authorization: Bearer sshc_...` authenticate
// as the token's owning user without a session cookie — and therefore
// also skip the CSRF header requirement (CSRF is a cookie-borne attack;
// a bearer header can't be attached by a hostile cross-origin page).
//
// Scope model: read → GET/HEAD/OPTIONS only; write → all methods.
// Role-based authorization (admin-only routes) still applies through the
// owning user's role — a token is never more powerful than its creator.

import type { Request, Response, NextFunction } from "express";
import crypto from "crypto";
import { db, apiTokensTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { childLogger } from "./logger.js";

const log = childLogger("api-token");

export const TOKEN_PREFIX = "sshc_";

export interface ApiTokenAuthInfo {
  userId: number;
  tokenId: number;
  scope: "read" | "write";
}

export function sha256Hex(input: string): string {
  return crypto.createHash("sha256").update(input).digest("hex");
}

export function generateApiToken(): { token: string; hash: string; prefix: string } {
  const body = crypto.randomBytes(20).toString("hex"); // 40 hex chars
  const token = `${TOKEN_PREFIX}${body}`;
  return { token, hash: sha256Hex(token), prefix: `${TOKEN_PREFIX}${body.slice(0, 6)}` };
}

// Throttle last_used_at writes: one per token per minute is plenty for
// "when was this last used" display and avoids write amplification from
// chatty automation clients.
const lastUsedWrites = new Map<number, number>();

export async function apiTokenAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  const header = req.get("Authorization");
  if (!header || !header.startsWith("Bearer ")) return next();
  const token = header.slice(7).trim();
  // Not our token format — leave it alone (some proxies attach their own
  // bearer tokens; those requests still need a session to authenticate).
  if (!token.startsWith(TOKEN_PREFIX)) return next();

  const [row] = await db
    .select()
    .from(apiTokensTable)
    .where(eq(apiTokensTable.tokenHash, sha256Hex(token)))
    .limit(1);

  if (!row) {
    res.status(401).json({ error: "Invalid API token" });
    return;
  }
  if (row.revokedAt) {
    res.status(401).json({ error: "API token has been revoked" });
    return;
  }
  if (row.expiresAt && row.expiresAt.getTime() < Date.now()) {
    res.status(401).json({ error: "API token has expired" });
    return;
  }
  const method = req.method.toUpperCase();
  if (row.scope === "read" && method !== "GET" && method !== "HEAD" && method !== "OPTIONS") {
    res.status(403).json({ error: "This API token is read-only" });
    return;
  }

  (req as any).apiTokenAuth = { userId: row.userId, tokenId: row.id, scope: row.scope } satisfies ApiTokenAuthInfo;

  const lastWrite = lastUsedWrites.get(row.id) ?? 0;
  if (Date.now() - lastWrite > 60_000) {
    lastUsedWrites.set(row.id, Date.now());
    db.update(apiTokensTable)
      .set({ lastUsedAt: new Date() })
      .where(eq(apiTokensTable.id, row.id))
      .catch((err) => log.warn({ err, tokenId: row.id }, "last_used_at update failed"));
  }
  next();
}
