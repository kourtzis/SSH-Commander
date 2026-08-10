import { pgTable, serial, text, integer, timestamp, pgEnum, index } from "drizzle-orm/pg-core";
import { usersTable } from "./users";

export const apiTokenScopeEnum = pgEnum("api_token_scope", ["read", "write"]);

// Bearer tokens for automation (scripts, CI, monitoring). The plaintext
// token (sshc_ + 40 hex chars) is shown exactly once at creation; only its
// sha256 hash is stored. `prefix` keeps the first characters for display so
// operators can match a leaked token to a row without us keeping the secret.
//
// Scope model: read = GET/HEAD only; write = all methods. Authorization
// beyond that (admin-only routes) still follows the owning user's role —
// a token is never MORE powerful than the user who minted it, and tokens
// die with their user (FK cascade).
export const apiTokensTable = pgTable("api_tokens", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  tokenHash: text("token_hash").notNull().unique(), // sha256 hex of the full plaintext token
  prefix: text("prefix").notNull(),                 // display-only: "sshc_" + first 6 hex chars
  scope: apiTokenScopeEnum("scope").notNull().default("read"),
  lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
  expiresAt: timestamp("expires_at", { withTimezone: true }),  // NULL = never expires
  revokedAt: timestamp("revoked_at", { withTimezone: true }),  // soft revoke — row kept for audit
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("idx_api_tokens_user_id").on(table.userId),
]);

export type ApiTokenRow = typeof apiTokensTable.$inferSelect;
