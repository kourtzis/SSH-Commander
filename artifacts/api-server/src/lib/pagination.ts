// ─── List-endpoint pagination helper ──────────────────────────────
// Shared by every GET-list route that opts into pagination. Behaviour:
//   • If the caller does NOT pass `?limit=`, the route returns the
//     existing array shape (backward compat — older clients keep working).
//   • If the caller passes `?limit=N` (and optionally `?offset=M`), the
//     route returns `{ items, total, limit, offset }` instead.
//
// Caps: limit ∈ [1, 500] to prevent memory blowups; offset clamped to ≥ 0.
// 500 is well above any realistic page-size selector but small enough that
// a misbehaving client can't ask for the whole table in one shot.

import type { Request } from "express";

export interface PageParams {
  limit: number;
  offset: number;
}

export function parsePagination(req: Request): PageParams | null {
  const raw = req.query.limit;
  if (raw === undefined) return null;
  const limit = Math.max(1, Math.min(500, parseInt(String(raw), 10) || 0));
  const offset = Math.max(0, parseInt(String(req.query.offset ?? "0"), 10) || 0);
  return { limit, offset };
}
