import { pgTable, serial, integer, date, index, uniqueIndex } from "drizzle-orm/pg-core";

// Daily reachability aggregates per device. Each row is one (router, day) pair.
// Background ping loop increments totalChecks and successCount.
export const deviceReachabilityTable = pgTable("device_reachability", {
  id: serial("id").primaryKey(),
  routerId: integer("router_id").notNull(),
  day: date("day").notNull(),
  totalChecks: integer("total_checks").notNull().default(0),
  successCount: integer("success_count").notNull().default(0),
}, (table) => [
  index("idx_device_reachability_router_id").on(table.routerId),
  uniqueIndex("uq_device_reachability_router_day").on(table.routerId, table.day),
]);

export type DeviceReachability = typeof deviceReachabilityTable.$inferSelect;
