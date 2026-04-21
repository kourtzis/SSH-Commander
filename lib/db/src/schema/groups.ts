import { pgTable, serial, text, integer, timestamp, index } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { routersTable } from "./routers";

// Hierarchical router group — supports nesting via parent_id and the subgroups join table.
// Groups allow targeting many routers at once when creating batch jobs.
export const routerGroupsTable = pgTable("router_groups", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  description: text("description"),
  // Legacy parent pointer (UI uses subgroups join table instead). FK to self
  // with ON DELETE SET NULL so deleting a parent group doesn't error and
  // doesn't cascade-destroy the children — the children just become roots.
  parentId: integer("parent_id").references((): any => routerGroupsTable.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("idx_router_groups_parent_id").on(table.parentId),
]);

// Many-to-many: which routers belong to which group. Both FKs cascade on
// delete — removing a router or group cleans up its membership rows so we
// never end up with orphaned join entries pointing at non-existent ids.
export const groupRoutersTable = pgTable("group_routers", {
  id: serial("id").primaryKey(),
  groupId: integer("group_id").notNull().references(() => routerGroupsTable.id, { onDelete: "cascade" }),
  routerId: integer("router_id").notNull().references(() => routersTable.id, { onDelete: "cascade" }),
}, (table) => [
  index("idx_group_routers_group_id").on(table.groupId),
  index("idx_group_routers_router_id").on(table.routerId),
]);

// Many-to-many: which groups are nested under which parent group.
// Used by resolveRouterIds() to walk the tree and collect all routers.
// Both sides cascade on delete for the same orphan-prevention reason as above.
export const groupSubgroupsTable = pgTable("group_subgroups", {
  id: serial("id").primaryKey(),
  parentGroupId: integer("parent_group_id").notNull().references(() => routerGroupsTable.id, { onDelete: "cascade" }),
  childGroupId: integer("child_group_id").notNull().references(() => routerGroupsTable.id, { onDelete: "cascade" }),
}, (table) => [
  index("idx_group_subgroups_parent").on(table.parentGroupId),
  index("idx_group_subgroups_child").on(table.childGroupId),
]);

export const insertGroupSchema = createInsertSchema(routerGroupsTable).omit({
  id: true,
  createdAt: true,
});

export type InsertGroup = z.infer<typeof insertGroupSchema>;
export type RouterGroup = typeof routerGroupsTable.$inferSelect;
