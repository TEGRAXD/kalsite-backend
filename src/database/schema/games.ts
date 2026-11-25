import {
  pgTable,
  varchar,
  integer,
  timestamp,
  index,
} from "drizzle-orm/pg-core";
import { rooms } from "./rooms";

export const games = pgTable(
  "games",
  {
    id: varchar("id", { length: 36 }).primaryKey(),
    roomId: varchar("room_id", { length: 36 })
      .notNull()
      .references(() => rooms.id, { onDelete: "cascade" }),
    status: varchar("status", { length: 24 }).default("active").notNull(),
    currentTurnUserId: varchar("current_turn_user_id", { length: 36 }),
    turnNumber: integer("turn_number").default(1).notNull(),
    startedAt: timestamp("started_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    endedAt: timestamp("ended_at", { withTimezone: true }),
  },
  (table) => [
    index("games_room_id_idx").on(table.roomId),
    index("games_status_idx").on(table.status),
  ],
);

export type Game = typeof games.$inferSelect;
export type NewGame = typeof games.$inferInsert;
