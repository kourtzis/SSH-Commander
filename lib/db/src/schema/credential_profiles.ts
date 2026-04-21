import { pgTable, serial, text, integer, timestamp, index, boolean, type AnyPgColumn } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

// Credential profiles let you define a set of SSH credentials once and reuse
// them across many devices. Includes optional jump-host (bastion) reference.
// jumpHostId references another credential_profiles row whose host fields are
// used as the SSH bastion. The jump host itself MUST have host/port set.
export const credentialProfilesTable = pgTable("credential_profiles", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  sshUsername: text("ssh_username").notNull(),
  sshPassword: text("ssh_password"),
  enablePassword: text("enable_password"),
  // Self-FK to another credential profile used as the SSH bastion. ON DELETE
  // SET NULL so deleting a profile that other profiles use as a jump host
  // doesn't hard-fail — those profiles just lose their bastion reference and
  // start refusing to connect with a clear "no jump host" error rather than
  // a foreign-key violation at API surface.
  jumpHostId: integer("jump_host_id").references((): AnyPgColumn => credentialProfilesTable.id, { onDelete: "set null" }),
  jumpHost: text("jump_host"),
  jumpPort: integer("jump_port"),
  description: text("description"),
  // Opt-in switch: enable legacy/insecure SSH algorithms (ssh-rsa server
  // host key, diffie-hellman-group1-sha1 KEX, 3des-cbc cipher, hmac-md5)
  // for this profile only. Defaults off — modern openssh-9 + RouterOS-7
  // negotiate fine without them. Turn on for old hardware (Cisco IOS 12,
  // ancient HP ProCurve, RouterOS-6 with stock crypto) where the
  // connection otherwise dies at "no matching host key/kex/mac". Scoped
  // per profile so a single legacy device doesn't widen the algorithm
  // surface for the whole fleet.
  useLegacyAlgorithms: boolean("use_legacy_algorithms").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("idx_credential_profiles_jump_host_id").on(table.jumpHostId),
]);

export const insertCredentialProfileSchema = createInsertSchema(credentialProfilesTable).omit({
  id: true,
  createdAt: true,
});

export type InsertCredentialProfile = z.infer<typeof insertCredentialProfileSchema>;
export type CredentialProfile = typeof credentialProfilesTable.$inferSelect;
