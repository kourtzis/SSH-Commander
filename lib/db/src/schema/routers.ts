import { pgTable, serial, text, integer, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

// SSH-managed router/device — each entry represents one target device
export const routersTable = pgTable("routers", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),            // Human-readable device label
  ipAddress: text("ip_address").notNull(),  // Hostname or IP used for SSH connection
  sshPort: integer("ssh_port").notNull().default(22),
  sshUsername: text("ssh_username").notNull(),
  sshPassword: text("ssh_password"),        // Stored in plaintext — encrypted at rest via DB-level encryption
  description: text("description"),         // Optional notes about the device
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const insertRouterSchema = createInsertSchema(routersTable).omit({
  id: true,
  createdAt: true,
});

export type InsertRouter = z.infer<typeof insertRouterSchema>;
export type RouterDevice = typeof routersTable.$inferSelect;
