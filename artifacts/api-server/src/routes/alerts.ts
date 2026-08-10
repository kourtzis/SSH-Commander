// ─── Alert channel / rule / event routes ────────────────────────────
// Channel configs carry live credentials (bot tokens, SMTP passwords,
// webhook secrets). They are encrypted at rest and NEVER returned to
// clients — GET responses replace each secret with a `<field>Set`
// boolean, and updates that omit or blank a secret keep the stored one.

import { Router, type IRouter } from "express";
import { db, notificationChannelsTable, alertRulesTable, alertEventsTable, encryptSecret, decryptSecret } from "@workspace/db";
import { desc, eq, inArray, count } from "drizzle-orm";
import { CreateAlertChannelBody, UpdateAlertChannelBody, CreateAlertRuleBody, UpdateAlertRuleBody } from "@workspace/api-zod";
import { requireAuth, requireAdminAuth } from "../lib/auth.js";
import { parsePagination } from "../lib/pagination.js";
import { deliverToChannel } from "../lib/alerts.js";
import { logAudit } from "../lib/audit.js";

const router: IRouter = Router();

type ChannelType = "telegram" | "email" | "webhook";

function decryptConfig(row: { config: string }): Record<string, unknown> {
  try {
    return JSON.parse(decryptSecret(row.config) ?? row.config) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** Merge incoming config over the stored one. Secret fields treat
 *  undefined/empty-string as "keep existing". Non-secret fields are
 *  taken from incoming when present. Unknown keys are dropped. */
function mergeChannelConfig(
  type: ChannelType,
  incoming: Record<string, unknown>,
  existing: Record<string, unknown> | null,
): Record<string, unknown> {
  const keepSecret = (key: string): string => {
    const v = incoming[key];
    if (v === undefined || v === null || v === "") return String(existing?.[key] ?? "");
    return String(v);
  };
  const take = (key: string, fallback: unknown = ""): unknown =>
    incoming[key] !== undefined ? incoming[key] : existing?.[key] ?? fallback;

  if (type === "telegram") {
    return { botToken: keepSecret("botToken"), chatId: String(take("chatId")) };
  }
  if (type === "email") {
    return {
      host: String(take("host")),
      port: Number(take("port", 587)) || 587,
      secure: Boolean(take("secure", false)),
      username: String(take("username")),
      password: keepSecret("password"),
      from: String(take("from")),
      to: String(take("to")),
    };
  }
  return { url: String(take("url")), secret: keepSecret("secret") };
}

function validateChannelConfig(type: ChannelType, cfg: Record<string, unknown>): string | null {
  if (type === "telegram") {
    if (!cfg.botToken) return "Telegram channel requires a botToken";
    if (!cfg.chatId) return "Telegram channel requires a chatId";
  }
  if (type === "email") {
    if (!cfg.host) return "Email channel requires an SMTP host";
    if (!cfg.to) return "Email channel requires a destination address (to)";
  }
  if (type === "webhook") {
    const url = String(cfg.url ?? "");
    if (!/^https?:\/\//i.test(url)) return "Webhook channel requires an http(s) url";
  }
  return null;
}

function sanitizeChannel(row: typeof notificationChannelsTable.$inferSelect) {
  const cfg = decryptConfig(row);
  let publicConfig: Record<string, unknown>;
  if (row.type === "telegram") {
    publicConfig = { chatId: cfg.chatId ?? "", botTokenSet: Boolean(cfg.botToken) };
  } else if (row.type === "email") {
    publicConfig = {
      host: cfg.host ?? "",
      port: cfg.port ?? 587,
      secure: Boolean(cfg.secure),
      username: cfg.username ?? "",
      from: cfg.from ?? "",
      to: cfg.to ?? "",
      passwordSet: Boolean(cfg.password),
    };
  } else {
    publicConfig = { url: cfg.url ?? "", secretSet: Boolean(cfg.secret) };
  }
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    enabled: row.enabled,
    config: publicConfig,
    lastUsedAt: row.lastUsedAt,
    lastError: row.lastError,
    createdAt: row.createdAt,
  };
}

// ─── Channels ───────────────────────────────────────────────────────

router.get("/alert-channels", async (req, res) => {
  requireAuth(req);
  const rows = await db.select().from(notificationChannelsTable).orderBy(notificationChannelsTable.name);
  res.json(rows.map(sanitizeChannel));
});

router.post("/alert-channels", async (req, res) => {
  await requireAdminAuth(req);
  const parsed = CreateAlertChannelBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request body" });
    return;
  }
  const type = parsed.data.type as ChannelType;
  const cfg = mergeChannelConfig(type, (parsed.data.config ?? {}) as Record<string, unknown>, null);
  const invalid = validateChannelConfig(type, cfg);
  if (invalid) {
    res.status(400).json({ error: invalid });
    return;
  }
  const [created] = await db.insert(notificationChannelsTable).values({
    name: parsed.data.name,
    type,
    config: encryptSecret(JSON.stringify(cfg)) ?? "",
    enabled: parsed.data.enabled ?? true,
  }).returning();
  void logAudit(req, "alert.channel_create", { resourceType: "alert_channel", resourceId: created.id, resourceName: created.name, details: { type } });
  res.status(201).json(sanitizeChannel(created));
});

router.put("/alert-channels/:id", async (req, res) => {
  await requireAdminAuth(req);
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  const parsed = UpdateAlertChannelBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request body" });
    return;
  }
  const [existing] = await db.select().from(notificationChannelsTable).where(eq(notificationChannelsTable.id, id)).limit(1);
  if (!existing) {
    res.status(404).json({ error: "Channel not found" });
    return;
  }
  const type = existing.type as ChannelType;
  const patch: Record<string, unknown> = {};
  if (parsed.data.name !== undefined) patch.name = parsed.data.name;
  if (parsed.data.enabled !== undefined) patch.enabled = parsed.data.enabled;
  if (parsed.data.config !== undefined) {
    const cfg = mergeChannelConfig(type, parsed.data.config as Record<string, unknown>, decryptConfig(existing));
    const invalid = validateChannelConfig(type, cfg);
    if (invalid) {
      res.status(400).json({ error: invalid });
      return;
    }
    patch.config = encryptSecret(JSON.stringify(cfg)) ?? "";
  }
  const [updated] = await db.update(notificationChannelsTable).set(patch).where(eq(notificationChannelsTable.id, id)).returning();
  void logAudit(req, "alert.channel_update", { resourceType: "alert_channel", resourceId: id, resourceName: updated.name });
  res.json(sanitizeChannel(updated));
});

router.delete("/alert-channels/:id", async (req, res) => {
  await requireAdminAuth(req);
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  const [deleted] = await db.delete(notificationChannelsTable).where(eq(notificationChannelsTable.id, id))
    .returning({ id: notificationChannelsTable.id, name: notificationChannelsTable.name });
  if (!deleted) {
    res.status(404).json({ error: "Channel not found" });
    return;
  }
  // Rules keep the stale channel id in channelIds — delivery simply skips
  // ids that no longer resolve, and the UI shows them as missing.
  void logAudit(req, "alert.channel_delete", { resourceType: "alert_channel", resourceId: id, resourceName: deleted.name });
  res.json({ message: "Channel deleted" });
});

router.post("/alert-channels/:id/test", async (req, res) => {
  await requireAdminAuth(req);
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  const [channel] = await db.select().from(notificationChannelsTable).where(eq(notificationChannelsTable.id, id)).limit(1);
  if (!channel) {
    res.status(404).json({ error: "Channel not found" });
    return;
  }
  void logAudit(req, "alert.channel_test", { resourceType: "alert_channel", resourceId: id, resourceName: channel.name });
  try {
    await deliverToChannel(channel, "test", "Test notification", `This is a test message from SSH Commander (channel: ${channel.name}).`);
    await db.update(notificationChannelsTable).set({ lastUsedAt: new Date(), lastError: null }).where(eq(notificationChannelsTable.id, id));
    res.json({ success: true, error: null });
  } catch (err: any) {
    const reason = err?.message ?? String(err);
    await db.update(notificationChannelsTable).set({ lastUsedAt: new Date(), lastError: reason }).where(eq(notificationChannelsTable.id, id));
    res.json({ success: false, error: reason });
  }
});

// ─── Rules ──────────────────────────────────────────────────────────

async function validateRuleChannels(channelIds: number[]): Promise<string | null> {
  if (channelIds.length === 0) return "Pick at least one notification channel";
  const found = await db.select({ value: count() }).from(notificationChannelsTable)
    .where(inArray(notificationChannelsTable.id, channelIds));
  if (Number(found[0]?.value ?? 0) !== channelIds.length) return "One or more channels do not exist";
  return null;
}

router.get("/alert-rules", async (req, res) => {
  requireAuth(req);
  const rows = await db.select().from(alertRulesTable).orderBy(alertRulesTable.name);
  res.json(rows);
});

router.post("/alert-rules", async (req, res) => {
  await requireAdminAuth(req);
  const parsed = CreateAlertRuleBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request body" });
    return;
  }
  const invalid = await validateRuleChannels(parsed.data.channelIds);
  if (invalid) {
    res.status(400).json({ error: invalid });
    return;
  }
  const [created] = await db.insert(alertRulesTable).values({
    name: parsed.data.name,
    eventTypes: parsed.data.eventTypes,
    routerIds: parsed.data.routerIds ?? [],
    groupIds: parsed.data.groupIds ?? [],
    channelIds: parsed.data.channelIds,
    cooldownMinutes: Math.max(0, Math.min(1440, parsed.data.cooldownMinutes ?? 5)),
    enabled: parsed.data.enabled ?? true,
  }).returning();
  void logAudit(req, "alert.rule_create", { resourceType: "alert_rule", resourceId: created.id, resourceName: created.name });
  res.status(201).json(created);
});

router.put("/alert-rules/:id", async (req, res) => {
  await requireAdminAuth(req);
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  const parsed = UpdateAlertRuleBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request body" });
    return;
  }
  const patch: Record<string, unknown> = {};
  if (parsed.data.name !== undefined) patch.name = parsed.data.name;
  if (parsed.data.eventTypes !== undefined) patch.eventTypes = parsed.data.eventTypes;
  if (parsed.data.routerIds !== undefined) patch.routerIds = parsed.data.routerIds;
  if (parsed.data.groupIds !== undefined) patch.groupIds = parsed.data.groupIds;
  if (parsed.data.channelIds !== undefined) {
    const invalid = await validateRuleChannels(parsed.data.channelIds);
    if (invalid) {
      res.status(400).json({ error: invalid });
      return;
    }
    patch.channelIds = parsed.data.channelIds;
  }
  if (parsed.data.cooldownMinutes !== undefined) patch.cooldownMinutes = Math.max(0, Math.min(1440, parsed.data.cooldownMinutes));
  if (parsed.data.enabled !== undefined) patch.enabled = parsed.data.enabled;
  const [updated] = await db.update(alertRulesTable).set(patch).where(eq(alertRulesTable.id, id)).returning();
  if (!updated) {
    res.status(404).json({ error: "Rule not found" });
    return;
  }
  void logAudit(req, "alert.rule_update", { resourceType: "alert_rule", resourceId: id, resourceName: updated.name });
  res.json(updated);
});

router.delete("/alert-rules/:id", async (req, res) => {
  await requireAdminAuth(req);
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  const [deleted] = await db.delete(alertRulesTable).where(eq(alertRulesTable.id, id))
    .returning({ id: alertRulesTable.id, name: alertRulesTable.name });
  if (!deleted) {
    res.status(404).json({ error: "Rule not found" });
    return;
  }
  void logAudit(req, "alert.rule_delete", { resourceType: "alert_rule", resourceId: id, resourceName: deleted.name });
  res.json({ message: "Rule deleted" });
});

// ─── History ────────────────────────────────────────────────────────

router.get("/alert-events", async (req, res) => {
  requireAuth(req);
  const page = parsePagination(req) ?? { limit: 50, offset: 0 };
  const [items, [{ value: total }]] = await Promise.all([
    db.select().from(alertEventsTable).orderBy(desc(alertEventsTable.createdAt)).limit(page.limit).offset(page.offset),
    db.select({ value: count() }).from(alertEventsTable),
  ]);
  res.json({ items, total });
});

export default router;
