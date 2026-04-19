// ─── Snippet Library Routes ─────────────────────────────────────────
// CRUD for reusable SSH command templates. Snippets can be tagged for
// categorization, and filtered by tag using PostgreSQL's native @> array
// containment operator (backed by a GIN index for fast lookups).

import { Router, type IRouter } from "express";
import { db, snippetsTable } from "@workspace/db";
import { eq, sql } from "drizzle-orm";
import { CreateSnippetBody, UpdateSnippetBody } from "@workspace/api-zod";
import { requireAuth } from "../lib/auth.js";

const router: IRouter = Router();

// GET /snippets — List all snippets, optionally filtered by a single tag.
// Tag filtering uses SQL-level @> containment (O(log n) with GIN index).
router.get("/snippets", async (req, res) => {
  requireAuth(req);
  const tag = req.query.tag as string | undefined;
  let query = db.select().from(snippetsTable).orderBy(snippetsTable.name);
  if (tag) {
    const filtered = await db.select().from(snippetsTable)
      .where(sql`${snippetsTable.tags} @> ARRAY[${tag}]::text[]`)
      .orderBy(snippetsTable.name);
    res.json(filtered);
  } else {
    res.json(await query);
  }
});

// POST /snippets — Create a new snippet
router.post("/snippets", async (req, res) => {
  requireAuth(req);
  const parsed = CreateSnippetBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request body" });
    return;
  }
  const { name, tags, code, description } = parsed.data;
  const [snippet] = await db
    .insert(snippetsTable)
    .values({ name, tags: tags || [], code, description })
    .returning();
  res.status(201).json(snippet);
});

// GET /snippets/:id — Get a single snippet by ID
router.get("/snippets/:id", async (req, res) => {
  requireAuth(req);
  const id = parseInt(req.params.id);
  const [snippet] = await db
    .select()
    .from(snippetsTable)
    .where(eq(snippetsTable.id, id))
    .limit(1);
  if (!snippet) {
    res.status(404).json({ error: "Snippet not found" });
    return;
  }
  res.json(snippet);
});

// PUT /snippets/:id — Update snippet fields (partial update, auto-updates updatedAt)
router.put("/snippets/:id", async (req, res) => {
  requireAuth(req);
  const id = parseInt(req.params.id);
  const parsed = UpdateSnippetBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request body" });
    return;
  }
  const updates: Record<string, any> = { updatedAt: new Date() };
  if (parsed.data.name !== undefined) updates.name = parsed.data.name;
  if (parsed.data.tags !== undefined) updates.tags = parsed.data.tags;
  if (parsed.data.code !== undefined) updates.code = parsed.data.code;
  if (parsed.data.description !== undefined) updates.description = parsed.data.description;

  const [updated] = await db
    .update(snippetsTable)
    .set(updates)
    .where(eq(snippetsTable.id, id))
    .returning();
  if (!updated) {
    res.status(404).json({ error: "Snippet not found" });
    return;
  }
  res.json(updated);
});

// DELETE /snippets/:id — Remove a snippet
router.delete("/snippets/:id", async (req, res) => {
  requireAuth(req);
  const id = parseInt(req.params.id);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid snippet id" }); return; }
  await db.delete(snippetsTable).where(eq(snippetsTable.id, id));
  res.json({ message: "Snippet deleted" });
});

export default router;
