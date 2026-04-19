// ─── Saved Views Routes ─────────────────────────────────────────────
// Per-user saved view definitions for list pages (devices, jobs, scheduler).
// Each view stores opaque JSON (search, sort, filter selections) keyed by
// pageKey so a user can have separate "Critical Routers" / "Failed Jobs"
// presets across the app.
//
// All endpoints scope to the current user — a user cannot see, create, or
// delete another user's views (no admin override; views are personal).

import { Router, type IRouter } from "express";
import { db, savedViewsTable } from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { requireAuth } from "../lib/auth.js";

const router: IRouter = Router();

// requireAuth() in this codebase only throws on failure (returns void), so
// pull the userId straight off the session for ownership scoping.
function getUserId(req: any): number {
  requireAuth(req);
  return (req.session as any).userId as number;
}

router.get("/saved-views", async (req, res) => {
  const user = { id: getUserId(req) };
  const pageKey = req.query.pageKey as string | undefined;
  const rows = await db
    .select()
    .from(savedViewsTable)
    .where(
      pageKey
        ? and(eq(savedViewsTable.userId, user.id), eq(savedViewsTable.pageKey, pageKey))
        : eq(savedViewsTable.userId, user.id),
    )
    .orderBy(savedViewsTable.name);
  res.json(rows);
});

router.post("/saved-views", async (req, res) => {
  const user = { id: getUserId(req) };
  const { pageKey, name, viewState } = req.body ?? {};
  if (!pageKey || !name || viewState === undefined) {
    res.status(400).json({ error: "pageKey, name, viewState required" });
    return;
  }
  const [created] = await db
    .insert(savedViewsTable)
    .values({ userId: user.id, pageKey, name, viewState })
    .returning();
  res.status(201).json(created);
});

router.delete("/saved-views/:id", async (req, res) => {
  const user = { id: getUserId(req) };
  const id = parseInt(req.params.id);
  // Scope by both id AND userId so a user cannot delete another user's view
  // even if they guess the id.
  await db
    .delete(savedViewsTable)
    .where(and(eq(savedViewsTable.id, id), eq(savedViewsTable.userId, user.id)));
  res.json({ message: "View deleted" });
});

export default router;
