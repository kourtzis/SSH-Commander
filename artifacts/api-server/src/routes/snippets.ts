import { Router, type IRouter } from "express";
import { db, snippetsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { CreateSnippetBody, UpdateSnippetBody } from "@workspace/api-zod";
import { requireAuth } from "../lib/auth.js";

const router: IRouter = Router();

router.get("/snippets", async (req, res) => {
  requireAuth(req);
  const snippets = await db.select().from(snippetsTable).orderBy(snippetsTable.name);
  const category = req.query.category as string | undefined;
  if (category) {
    res.json(snippets.filter((s) => s.category === category));
  } else {
    res.json(snippets);
  }
});

router.post("/snippets", async (req, res) => {
  requireAuth(req);
  const parsed = CreateSnippetBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request body" });
    return;
  }
  const { name, category, code, description } = parsed.data;
  const [snippet] = await db
    .insert(snippetsTable)
    .values({ name, category, code, description })
    .returning();
  res.status(201).json(snippet);
});

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
  if (parsed.data.category !== undefined) updates.category = parsed.data.category;
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

router.delete("/snippets/:id", async (req, res) => {
  requireAuth(req);
  await db.delete(snippetsTable).where(eq(snippetsTable.id, parseInt(req.params.id)));
  res.json({ message: "Snippet deleted" });
});

export default router;
