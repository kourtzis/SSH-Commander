import { pgTable, serial, text, integer, timestamp, index } from "drizzle-orm/pg-core";
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
  jumpHostId: integer("jump_host_id"),
  jumpHost: text("jump_host"),
  jumpPort: integer("jump_port"),
  description: text("description"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (table) => [
  index("idx_credential_profiles_jump_host_id").on(table.jumpHostId),
]);

export const insertCredentialProfileSchema = createInsertSchema(credentialProfilesTable).omit({
  id: true,
  createdAt: true,
});

export type InsertCredentialProfile = z.infer<typeof insertCredentialProfileSchema>;
export type CredentialProfile = typeof credentialProfilesTable.$inferSelect;
