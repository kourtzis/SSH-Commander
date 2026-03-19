import { pgTable, serial, text, integer, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const routerGroupsTable = pgTable("router_groups", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  description: text("description"),
  parentId: integer("parent_id"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const groupRoutersTable = pgTable("group_routers", {
  id: serial("id").primaryKey(),
  groupId: integer("group_id").notNull(),
  routerId: integer("router_id").notNull(),
});

export const groupSubgroupsTable = pgTable("group_subgroups", {
  id: serial("id").primaryKey(),
  parentGroupId: integer("parent_group_id").notNull(),
  childGroupId: integer("child_group_id").notNull(),
});

export const insertGroupSchema = createInsertSchema(routerGroupsTable).omit({
  id: true,
  createdAt: true,
});

export type InsertGroup = z.infer<typeof insertGroupSchema>;
export type RouterGroup = typeof routerGroupsTable.$inferSelect;
