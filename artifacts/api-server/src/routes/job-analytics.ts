// ─── Job Output Analytics ───────────────────────────────────────────
// Two read-only views over job_tasks.output:
//   * GET /jobs/output-search    — fleet-wide substring search across all
//     device outputs the caller may see, with server-built snippets.
//   * GET /jobs/:id/output-groups — collapse a job's tasks into groups of
//     identical output, so "58 devices said exactly this" reads as one row.
//
// MUST be mounted BEFORE jobsRouter: otherwise /jobs/output-search would be
// captured by jobs' /jobs/:id parameter route ("output-search" → NaN → 400).

import { Router, type IRouter } from "express";
import type { Request } from "express";
import crypto from "crypto";
import { db, batchJobsTable, jobTasksTable } from "@workspace/db";
import type { User } from "@workspace/db";
import { and, desc, eq, ilike, isNotNull, sql, type SQL } from "drizzle-orm";
import { getCurrentUser, requireAuth } from "../lib/auth.js";
import { parsePagination } from "../lib/pagination.js";

const router: IRouter = Router();

// Escape ILIKE metacharacters so a literal "%" or "_" in the search term
// matches itself instead of acting as a wildcard (backslash is Postgres's
// default LIKE escape character).
function escapeLike(term: string): string {
  return term.replace(/([\\%_])/g, "\\$1");
}

// Build a ±120-char window around the first case-insensitive match. The
// client never receives the full output here — hits can be hundreds of KB
// of terminal scrollback, and the search page only needs context.
function buildSnippet(output: string, term: string): string {
  const idx = output.toLowerCase().indexOf(term.toLowerCase());
  if (idx === -1) return output.slice(0, 240);
  const start = Math.max(0, idx - 120);
  const end = Math.min(output.length, idx + term.length + 120);
  return (start > 0 ? "…" : "") + output.slice(start, end) + (end < output.length ? "…" : "");
}

// GET /jobs/output-search?q=&limit=&offset= — search device outputs.
// Visibility mirrors requireJobAccess: admins search everything, operators
// only the jobs they created.
router.get("/jobs/output-search", async (req, res) => {
  requireAuth(req);
  const user = await getCurrentUser(req);
  if (!user) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const q = String(req.query.q ?? "").trim();
  if (q.length < 2) {
    res.status(400).json({ error: "Search term must be at least 2 characters" });
    return;
  }

  const page = parsePagination(req) ?? { limit: 50, offset: 0 };
  const pattern = `%${escapeLike(q)}%`;

  const conditions: SQL[] = [
    isNotNull(jobTasksTable.output),
    ilike(jobTasksTable.output, pattern),
  ];
  if (user.role !== "admin") {
    conditions.push(eq(batchJobsTable.createdBy, user.id));
  }
  const where = and(...conditions);

  const [rows, [{ total }]] = await Promise.all([
    db
      .select({
        jobId: jobTasksTable.jobId,
        jobName: batchJobsTable.name,
        taskId: jobTasksTable.id,
        routerName: jobTasksTable.routerName,
        routerIp: jobTasksTable.routerIp,
        status: jobTasksTable.status,
        output: jobTasksTable.output,
        createdAt: jobTasksTable.completedAt,
      })
      .from(jobTasksTable)
      .innerJoin(batchJobsTable, eq(jobTasksTable.jobId, batchJobsTable.id))
      .where(where)
      .orderBy(desc(jobTasksTable.id))
      .limit(page.limit)
      .offset(page.offset),
    db
      .select({ total: sql<number>`count(*)::int` })
      .from(jobTasksTable)
      .innerJoin(batchJobsTable, eq(jobTasksTable.jobId, batchJobsTable.id))
      .where(where),
  ]);

  res.json({
    items: rows.map((r) => ({
      jobId: r.jobId,
      jobName: r.jobName,
      taskId: r.taskId,
      routerName: r.routerName,
      routerIp: r.routerIp,
      status: r.status,
      snippet: buildSnippet(r.output ?? "", q),
      createdAt: r.createdAt,
    })),
    total,
  });
});

// Local mirror of jobs.ts requireJobAccess (not exported there): admins can
// see any job; operators only their own — and a foreign job id answers 404,
// not 403, so operators can't probe which ids exist.
async function assertJobVisible(req: Request, jobId: number): Promise<User> {
  requireAuth(req);
  const user = await getCurrentUser(req);
  if (!user) {
    const err: any = new Error("Unauthorized");
    err.status = 401;
    throw err;
  }
  if (Number.isNaN(jobId)) {
    const err: any = new Error("Invalid job id");
    err.status = 400;
    throw err;
  }
  const [job] = await db
    .select({ createdBy: batchJobsTable.createdBy })
    .from(batchJobsTable)
    .where(eq(batchJobsTable.id, jobId))
    .limit(1);
  if (!job || (user.role !== "admin" && job.createdBy !== user.id)) {
    const err: any = new Error("Job not found");
    err.status = 404;
    throw err;
  }
  return user;
}

// GET /jobs/:id/output-groups — group a job's finished tasks by identical
// output (sha256 of trimmed text). Tasks still pending/running/waiting for
// input are excluded — their output is absent or incomplete.
router.get("/jobs/:id/output-groups", async (req, res) => {
  const jobId = Number(req.params.id);
  await assertJobVisible(req, jobId);

  const tasks = await db
    .select({
      id: jobTasksTable.id,
      routerName: jobTasksTable.routerName,
      status: jobTasksTable.status,
      output: jobTasksTable.output,
    })
    .from(jobTasksTable)
    .where(
      and(
        eq(jobTasksTable.jobId, jobId),
        sql`${jobTasksTable.status} IN ('success', 'failed', 'needs_attention')`,
      ),
    )
    .orderBy(jobTasksTable.id);

  const groups = new Map<
    string,
    { outputHash: string; count: number; routerNames: string[]; taskIds: number[]; statuses: Set<string>; sampleOutput: string }
  >();

  for (const t of tasks) {
    const text = (t.output ?? "").trim();
    const hash = crypto.createHash("sha256").update(text).digest("hex");
    let g = groups.get(hash);
    if (!g) {
      // ~4000 chars of sample is enough for the UI preview pane; the full
      // output remains available via the task detail endpoint.
      g = { outputHash: hash, count: 0, routerNames: [], taskIds: [], statuses: new Set(), sampleOutput: text.slice(0, 4000) };
      groups.set(hash, g);
    }
    g.count++;
    g.routerNames.push(t.routerName);
    g.taskIds.push(t.id);
    g.statuses.add(t.status);
  }

  const result = [...groups.values()]
    .sort((a, b) => b.count - a.count || a.outputHash.localeCompare(b.outputHash))
    .map((g) => ({
      outputHash: g.outputHash,
      count: g.count,
      routerNames: g.routerNames,
      taskIds: g.taskIds,
      statuses: [...g.statuses],
      sampleOutput: g.sampleOutput,
    }));

  res.json(result);
});

export default router;
