import {
  pgTable,
  varchar,
  jsonb,
  timestamp,
  index,
} from "drizzle-orm/pg-core";
import { games } from "./games";
import { users } from "./users";

export const gameEvents = pgTable(
  "game_events",
  {
    id: varchar("id", { length: 36 }).primaryKey(),
    gameId: varchar("game_id", { length: 36 })
      .notNull()
      .references(() => games.id, { onDelete: "cascade" }),
    userId: varchar("user_id", { length: 36 }).references(() => users.id, {
      onDelete: "set null",
    }),
    eventType: varchar("event_type", { length: 48 }).notNull(),
    payloadJson: jsonb("payload_json").$type<Record<string, unknown>>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("game_events_game_id_idx").on(table.gameId),
    index("game_events_type_idx").on(table.eventType),
  ],
);

export type GameEvent = typeof gameEvents.$inferSelect;
export type NewGameEvent = typeof gameEvents.$inferInsert;
