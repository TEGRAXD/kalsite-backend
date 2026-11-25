import {
  pgTable,
  varchar,
  integer,
  timestamp,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { games } from "./games";
import { users } from "./users";
import { operators } from "./operators";

export const gamePlayers = pgTable(
  "game_players",
  {
    id: varchar("id", { length: 36 }).primaryKey(),
    gameId: varchar("game_id", { length: 36 })
      .notNull()
      .references(() => games.id, { onDelete: "cascade" }),
    userId: varchar("user_id", { length: 36 })
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    operatorId: varchar("operator_id", { length: 36 })
      .notNull()
      .references(() => operators.id, { onDelete: "restrict" }),
    seatOrder: integer("seat_order").default(0).notNull(),
    livesRemaining: integer("lives_remaining").default(3).notNull(),
    guessedAt: timestamp("guessed_at", { withTimezone: true }),
    eliminatedAt: timestamp("eliminated_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("game_players_game_user_unique").on(table.gameId, table.userId),
    index("game_players_game_id_idx").on(table.gameId),
  ],
);

export type GamePlayer = typeof gamePlayers.$inferSelect;
export type NewGamePlayer = typeof gamePlayers.$inferInsert;
