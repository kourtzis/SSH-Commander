// ─── Audit log routes (admin-only) ──────────────────────────────────

import { Router, type IRouter } from "express";
import { db, auditLogTable } from "@workspace/db";
import { and, desc, eq, gte, ilike, lte, or, count } from "drizzle-orm";
import { requireAdminAuth } from "../lib/auth.js";
import { parsePagination } from "../lib/pagination.js";

const router: IRouter = Router();

// GET /audit — filterable, paged.
router.get("/audit", async (req, res) => {
  await requireAdminAuth(req);
  const page = parsePagination(req) ?? { limit: 50, offset: 0 };

  const conditions = [];
  const userId = parseInt(String(req.query.userId ?? ""), 10);
  if (!Number.isNaN(userId)) conditions.push(eq(auditLogTable.userId, userId));
  const action = String(req.query.action ?? "").trim();
  if (action) conditions.push(eq(auditLogTable.action, action));
  const resourceType = String(req.query.resourceType ?? "").trim();
  if (resourceType) conditions.push(eq(auditLogTable.resourceType, resourceType));
  const q = String(req.query.q ?? "").trim();
  if (q) {
    const escaped = q.replace(/[\\%_]/g, (m) => `\\${m}`);
    const pattern = `%${escaped}%`;
    conditions.push(or(
      ilike(auditLogTable.username, pattern),
      ilike(auditLogTable.action, pattern),
      ilike(auditLogTable.resourceName, pattern),
    ));
  }
  const from = String(req.query.from ?? "").trim();
  if (from && !Number.isNaN(Date.parse(from))) conditions.push(gte(auditLogTable.createdAt, new Date(from)));
  const to = String(req.query.to ?? "").trim();
  if (to && !Number.isNaN(Date.parse(to))) conditions.push(lte(auditLogTable.createdAt, new Date(to)));

  const where = conditions.length > 0 ? and(...conditions) : undefined;
  const [items, [{ value: total }]] = await Promise.all([
    db.select().from(auditLogTable).where(where)
      .orderBy(desc(auditLogTable.createdAt), desc(auditLogTable.id))
      .limit(page.limit).offset(page.offset),
    db.select({ value: count() }).from(auditLogTable).where(where),
  ]);
  res.json({ items, total });
});

// GET /audit/actions — distinct action names for the filter dropdown.
router.get("/audit/actions", async (req, res) => {
  await requireAdminAuth(req);
  const rows = await db.selectDistinct({ action: auditLogTable.action }).from(auditLogTable).orderBy(auditLogTable.action);
  res.json(rows.map((r) => r.action));
});

export default router;
