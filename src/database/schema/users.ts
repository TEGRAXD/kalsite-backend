import { pgTable, varchar, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

export const users = pgTable(
  "users",
  {
    id: varchar("id", { length: 36 }).primaryKey(),
    discordId: varchar("discord_id", { length: 64 }).notNull(),
    username: varchar("username", { length: 100 }).notNull(),
    globalName: varchar("global_name", { length: 100 }),
    avatar: varchar("avatar", { length: 255 }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [uniqueIndex("users_discord_id_unique").on(table.discordId)],
);

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
