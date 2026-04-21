import { pgTable, serial, integer, text, json, timestamp, index } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

// Per-user saved view definitions. pageKey identifies which page the view
// applies to (e.g. "devices", "jobs", "scheduler"). viewState is opaque JSON
// owned by that page (search, sort, filter selections).
export const savedViewsTable = pgTable("saved_views", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull(),
  pageKey: text("page_key").notNull(),
  name: text("name").notNull(),
  viewState: json("view_state").$type<Record<string, unknown>>().notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("idx_saved_views_user_page").on(table.userId, table.pageKey),
]);

export const insertSavedViewSchema = createInsertSchema(savedViewsTable).omit({
  id: true,
  createdAt: true,
});

export type InsertSavedView = z.infer<typeof insertSavedViewSchema>;
export type SavedView = typeof savedViewsTable.$inferSelect;
