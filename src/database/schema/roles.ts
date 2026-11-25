import { pgTable, varchar, timestamp } from "drizzle-orm/pg-core";

export const ROLE_IDS = {
  SUPER_ADMIN: "super-administrator",
  ADMIN: "administrator",
  USER: "user",
} as const;

export type RoleId = (typeof ROLE_IDS)[keyof typeof ROLE_IDS];

export const roles = pgTable("roles", {
  id: varchar("id", { length: 40 }).primaryKey(),
  name: varchar("name", { length: 80 }).notNull(),
  description: varchar("description", { length: 255 }),
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

export type Role = typeof roles.$inferSelect;
export type NewRole = typeof roles.$inferInsert;
