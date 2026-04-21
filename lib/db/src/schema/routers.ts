import { pgTable, serial, text, integer, timestamp, index } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { credentialProfilesTable } from "./credential_profiles";

// SSH-managed router/device — each entry represents one target device
export const routersTable = pgTable("routers", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),            // Human-readable device label
  ipAddress: text("ip_address").notNull(),  // Hostname or IP used for SSH connection
  sshPort: integer("ssh_port").notNull().default(22),
  sshUsername: text("ssh_username").notNull(),
  sshPassword: text("ssh_password"),        // 1.14.0+: encrypted at rest with AES-256-GCM (see lib/db/src/crypto.ts). Legacy plaintext rows are accepted on read and re-encrypted on next write / migration.
  enablePassword: text("enable_password"),  // 1.14.0+: encrypted at rest (see sshPassword above).
  description: text("description"),         // Optional notes about the device
  // Optional FK to credential_profiles. ON DELETE SET NULL so deleting a
  // profile doesn't orphan the routers that referenced it — they fall back
  // to inline credentials (or fail loudly if there are none) rather than
  // pointing at a phantom profile id forever.
  credentialProfileId: integer("credential_profile_id").references(() => credentialProfilesTable.id, { onDelete: "set null" }),
  vendor: text("vendor"),                   // Auto-detected: e.g. "MikroTik", "Cisco", "Linux"
  model: text("model"),                     // Auto-detected: e.g. "RB4011iGS+", "WS-C2960-24TT-L"
  osVersion: text("os_version"),            // Auto-detected: e.g. "RouterOS 7.10.2"
  lastFingerprintAt: timestamp("last_fingerprint_at", { withTimezone: true }),
  // SHA256 fingerprint of the device's SSH host key, captured on first
  // successful connection (TOFU — trust on first use). Subsequent connections
  // refuse to authenticate if the presented key fingerprint differs from this
  // value, defending against MITM attacks. Cleared via the "Re-pin" admin
  // action when the device's key legitimately rotates.
  sshHostKeyFingerprint: text("ssh_host_key_fingerprint"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  // FK index — every routers SELECT joined by credential_profile_id
  // (effective-creds resolver, group membership tools) was previously
  // doing a sequential scan on large fleets. The cardinality is low
  // (handful of profiles, many routers) but the lookup is hot.
  index("idx_routers_credential_profile_id").on(table.credentialProfileId),
  index("idx_routers_name").on(table.name),
  index("idx_routers_ip_address").on(table.ipAddress),
]);

export const insertRouterSchema = createInsertSchema(routersTable).omit({
  id: true,
  createdAt: true,
});

export type InsertRouter = z.infer<typeof insertRouterSchema>;
export type RouterDevice = typeof routersTable.$inferSelect;
