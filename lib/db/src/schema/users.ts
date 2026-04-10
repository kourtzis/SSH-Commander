import { pgTable, serial, text, timestamp, pgEnum } from "drizzle-orm/pg-core";
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
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

// Zod schema for inserting new users (auto-fields excluded)
export const insertUserSchema = createInsertSchema(usersTable).omit({
  id: true,
  createdAt: true,
});

export type InsertUser = z.infer<typeof insertUserSchema>;
export type User = typeof usersTable.$inferSelect;
