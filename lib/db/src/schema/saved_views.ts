import { pgTable, serial, integer, text, json, timestamp, index } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { usersTable } from "./users";

// Per-user saved view definitions. pageKey identifies which page the view
// applies to (e.g. "devices", "jobs", "scheduler"). viewState is opaque JSON
// owned by that page (search, sort, filter selections).
export const savedViewsTable = pgTable("saved_views", {
  id: serial("id").primaryKey(),
  // FK to users.id with ON DELETE CASCADE. Saved views are entirely scoped
  // to one user; when the user is deleted, their personal view definitions
  // should disappear with them — they're never shared.
  userId: integer("user_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
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
