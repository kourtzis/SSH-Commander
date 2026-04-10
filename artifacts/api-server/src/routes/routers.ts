// ─── Router Management Routes ───────────────────────────────────────
// CRUD for SSH-managed devices (routers), plus bulk import from CSV/Excel
// and TCP-based reachability checks for real-time status indicators.

import { Router, type IRouter } from "express";
import { db, routersTable } from "@workspace/db";
import { eq, inArray } from "drizzle-orm";
import { CreateRouterBody, UpdateRouterBody } from "@workspace/api-zod";
import { requireAuth } from "../lib/auth.js";
import * as net from "net";

const router: IRouter = Router();

// Strip the SSH password from responses to avoid leaking credentials to the frontend
function sanitizeRouter(r: typeof routersTable.$inferSelect) {
  return {
    id: r.id,
    name: r.name,
    ipAddress: r.ipAddress,
    sshPort: r.sshPort,
    sshUsername: r.sshUsername,
    description: r.description,
    createdAt: r.createdAt,
  };
}

// GET /routers — List all routers (column-selective: excludes sshPassword)
router.get("/routers", async (req, res) => {
  requireAuth(req);
  const routers = await db
    .select({
      id: routersTable.id,
      name: routersTable.name,
      ipAddress: routersTable.ipAddress,
      sshPort: routersTable.sshPort,
      sshUsername: routersTable.sshUsername,
      description: routersTable.description,
      createdAt: routersTable.createdAt,
    })
    .from(routersTable)
    .orderBy(routersTable.name);
  res.json(routers);
});

// POST /routers — Create a single router
router.post("/routers", async (req, res) => {
  requireAuth(req);
  const parsed = CreateRouterBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request body" });
    return;
  }
  const { name, ipAddress, sshPort, sshUsername, sshPassword, description } = parsed.data;
  const [newRouter] = await db
    .insert(routersTable)
    .values({ name, ipAddress, sshPort: sshPort ?? 22, sshUsername, sshPassword, description })
    .returning();
  res.status(201).json(sanitizeRouter(newRouter));
});

// GET /routers/:id — Get a single router by ID
router.get("/routers/:id", async (req, res) => {
  requireAuth(req);
  const id = parseInt(req.params.id);
  const [r] = await db
    .select()
    .from(routersTable)
    .where(eq(routersTable.id, id))
    .limit(1);
  if (!r) {
    res.status(404).json({ error: "Router not found" });
    return;
  }
  res.json(sanitizeRouter(r));
});

// PUT /routers/:id — Update router fields (partial update — only provided fields are changed)
router.put("/routers/:id", async (req, res) => {
  requireAuth(req);
  const id = parseInt(req.params.id);
  const parsed = UpdateRouterBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request body" });
    return;
  }
  const { name, ipAddress, sshPort, sshUsername, sshPassword, description } = parsed.data;
  const updates: Record<string, any> = {};
  if (name !== undefined) updates.name = name;
  if (ipAddress !== undefined) updates.ipAddress = ipAddress;
  if (sshPort !== undefined) updates.sshPort = sshPort;
  if (sshUsername !== undefined) updates.sshUsername = sshUsername;
  if (sshPassword !== undefined) updates.sshPassword = sshPassword;
  if (description !== undefined) updates.description = description;

  const [updated] = await db
    .update(routersTable)
    .set(updates)
    .where(eq(routersTable.id, id))
    .returning();
  if (!updated) {
    res.status(404).json({ error: "Router not found" });
    return;
  }
  res.json(sanitizeRouter(updated));
});

// DELETE /routers/:id — Remove a router
router.delete("/routers/:id", async (req, res) => {
  requireAuth(req);
  await db.delete(routersTable).where(eq(routersTable.id, parseInt(req.params.id)));
  res.json({ message: "Router deleted" });
});

// POST /routers/import — Bulk import routers from CSV/Excel data.
// Attempts a single batch insert first; if that fails (e.g. duplicate name),
// falls back to inserting one-by-one so partial success is possible.
router.post("/routers/import", async (req, res) => {
  requireAuth(req);
  const { routers: items } = req.body as { routers: any[] };
  if (!Array.isArray(items) || items.length === 0) {
    res.status(400).json({ error: "No routers provided" });
    return;
  }
  if (items.length > 10000) {
    res.status(400).json({ error: "Too many routers (max 10,000 per import)" });
    return;
  }

  const results: { index: number; name: string; status: "created" | "error"; error?: string }[] = [];
  let created = 0;
  let failed = 0;

  // Phase 1: Validate all rows and build insert values
  const validRows: { index: number; name: string; values: typeof routersTable.$inferInsert }[] = [];

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const name = (item.name || "").toString().trim();
    const ipAddress = (item.ipAddress || "").toString().trim();
    const sshUsername = (item.sshUsername || "admin").toString().trim();
    const sshPort = parseInt(item.sshPort) || 22;
    const sshPassword = (item.sshPassword || "").toString().trim() || undefined;
    const description = (item.description || "").toString().trim() || undefined;

    if (!name || !ipAddress) {
      results.push({ index: i, name: name || `Row ${i + 1}`, status: "error", error: "Missing name or IP address" });
      failed++;
      continue;
    }

    validRows.push({ index: i, name, values: { name, ipAddress, sshPort, sshUsername, sshPassword, description } });
  }

  // Phase 2: Try batch insert first (fast path), fall back to individual inserts on error
  if (validRows.length > 0) {
    try {
      await db.insert(routersTable).values(validRows.map((r) => r.values));
      for (const row of validRows) {
        results.push({ index: row.index, name: row.name, status: "created" });
        created++;
      }
    } catch (err: any) {
      // Batch failed — retry each row individually to allow partial success
      for (const row of validRows) {
        try {
          await db.insert(routersTable).values(row.values);
          results.push({ index: row.index, name: row.name, status: "created" });
          created++;
        } catch (rowErr: any) {
          results.push({ index: row.index, name: row.name, status: "error", error: rowErr.message });
          failed++;
        }
      }
    }
  }

  res.json({ created, failed, total: items.length, results });
});

// ─── Reachability Check ─────────────────────────────────────────────
// Attempts a TCP connection to each router's SSH port to determine
// if the device is reachable. Used by the frontend for status indicators.

// Try to open a TCP socket to host:port within the timeout window
function checkPort(host: string, port: number, timeoutMs = 3000): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let resolved = false;
    const done = (result: boolean) => {
      if (resolved) return;
      resolved = true;
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
    socket.connect(port, host);
  });
}

// POST /routers/check-reachability — Check SSH port reachability for multiple routers in parallel
router.post("/routers/check-reachability", async (req, res) => {
  requireAuth(req);
  const { routerIds } = req.body as { routerIds: number[] };
  if (!Array.isArray(routerIds) || routerIds.length === 0) {
    res.json({});
    return;
  }

  // Validate input: max 500 IDs, all must be positive integers
  if (routerIds.length > 500 || !routerIds.every((id) => Number.isInteger(id) && id > 0)) {
    res.status(400).json({ error: "Invalid routerIds (max 500 integer IDs)" });
    return;
  }

  // Fetch only the fields needed for the TCP check
  const routers = await db
    .select({ id: routersTable.id, ipAddress: routersTable.ipAddress, sshPort: routersTable.sshPort })
    .from(routersTable)
    .where(inArray(routersTable.id, routerIds));

  // Check all routers in parallel
  const results: Record<number, boolean> = {};
  await Promise.all(
    routers.map(async (r) => {
      results[r.id] = await checkPort(r.ipAddress, r.sshPort ?? 22);
    })
  );

  res.json(results);
});

export default router;
