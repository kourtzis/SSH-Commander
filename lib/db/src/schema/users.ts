import { pgTable, serial, text, timestamp, pgEnum, boolean } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

// Two-tier role system: admins can manage users, operators can only use the app
export const userRoleEnum = pgEnum("user_role", ["admin", "operator"]);

// Core user table — stores login credentials and role assignment
export const usersTable = pgTable("users", {
  id: serial("id").primaryKey(),
  username: text("username").notNull().unique(),
  email: text("email"),
  passwordHash: text("password_hash").notNull(), // bcrypt-hashed password
  role: userRoleEnum("role").notNull().default("operator"),
  // Per-user grant for the per-device interactive terminal. Admins always
  // have terminal access; operators must be explicitly granted because a
  // terminal is a raw root shell on production gear with no audit trail.
  canTerminal: boolean("can_terminal").notNull().default(false),
  // ── TOTP two-factor auth (2.0.0) ──────────────────────────────────
  // totpSecret is encrypted at rest (lib/db/src/crypto.ts). It is written
  // during enrollment but 2FA only becomes mandatory once totpEnabled is
  // set by a successful confirm — an abandoned setup never locks anyone out.
  totpSecret: text("totp_secret"),
  totpEnabled: boolean("totp_enabled").notNull().default(false),
  // bcrypt-hashed single-use recovery codes; entries are removed as used.
  recoveryCodes: text("recovery_codes").array(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// Zod schema for inserting new users (auto-fields excluded)
export const insertUserSchema = createInsertSchema(usersTable).omit({
  id: true,
  createdAt: true,
});

export type InsertUser = z.infer<typeof insertUserSchema>;
export type User = typeof usersTable.$inferSelect;
