import { pgTable, serial, text, timestamp, index } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

// Reusable code snippet library — stores SSH command templates that can be
// inserted into jobs. Tags enable categorization and fast filtering via
// the GIN index (PostgreSQL array containment @> queries).
export const snippetsTable = pgTable("snippets", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  tags: text("tags").array().notNull().default([]),  // Filterable labels (e.g. ["mikrotik", "firewall"])
  code: text("code").notNull(),                      // SSH command template — may contain {{TAG}} placeholders
  description: text("description"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("idx_snippets_tags").using("gin", table.tags), // GIN index for fast @> containment queries
]);

export const insertSnippetSchema = createInsertSchema(snippetsTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertSnippet = z.infer<typeof insertSnippetSchema>;
export type Snippet = typeof snippetsTable.$inferSelect;
