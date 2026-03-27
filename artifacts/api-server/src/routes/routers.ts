import { Router, type IRouter } from "express";
import { db, routersTable } from "@workspace/db";
import { eq, inArray } from "drizzle-orm";
import { CreateRouterBody, UpdateRouterBody } from "@workspace/api-zod";
import { requireAuth } from "../lib/auth.js";
import * as net from "net";

const router: IRouter = Router();

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

router.get("/routers", async (req, res) => {
  requireAuth(req);
  const routers = await db.select().from(routersTable).orderBy(routersTable.name);
  res.json(routers.map(sanitizeRouter));
});

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

router.delete("/routers/:id", async (req, res) => {
  requireAuth(req);
  await db.delete(routersTable).where(eq(routersTable.id, parseInt(req.params.id)));
  res.json({ message: "Router deleted" });
});

router.post("/routers/import", async (req, res) => {
  requireAuth(req);
  const { routers: items } = req.body as { routers: any[] };
  if (!Array.isArray(items) || items.length === 0) {
    res.status(400).json({ error: "No routers provided" });
    return;
  }

  const results: { index: number; name: string; status: "created" | "error"; error?: string }[] = [];
  let created = 0;
  let failed = 0;

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

    try {
      await db.insert(routersTable).values({ name, ipAddress, sshPort, sshUsername, sshPassword, description });
      results.push({ index: i, name, status: "created" });
      created++;
    } catch (err: any) {
      results.push({ index: i, name, status: "error", error: err.message });
      failed++;
    }
  }

  res.json({ created, failed, total: items.length, results });
});

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

router.post("/routers/check-reachability", async (req, res) => {
  requireAuth(req);
  const { routerIds } = req.body as { routerIds: number[] };
  if (!Array.isArray(routerIds) || routerIds.length === 0) {
    res.json({});
    return;
  }

  const routers = await db
    .select({ id: routersTable.id, ipAddress: routersTable.ipAddress, sshPort: routersTable.sshPort })
    .from(routersTable)
    .where(inArray(routersTable.id, routerIds));

  const results: Record<number, boolean> = {};
  await Promise.all(
    routers.map(async (r) => {
      results[r.id] = await checkPort(r.ipAddress, r.sshPort ?? 22);
    })
  );

  res.json(results);
});

export default router;
