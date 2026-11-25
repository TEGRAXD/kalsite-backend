import {
  pgTable,
  varchar,
  jsonb,
  timestamp,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";
import { users } from "./users";

export interface RoomSettings {
  maxPlayers: number;
  lives: number;
  turnTimerSeconds: number | null;
  allowPass: boolean;
  maxQuestionsPerTurn: number;
  operatorPool: {
    rarities: number[];
    classes: string[];
  };
}

export const DEFAULT_ROOM_SETTINGS: RoomSettings = {
  maxPlayers: 6,
  lives: 3,
  turnTimerSeconds: null,
  allowPass: true,
  maxQuestionsPerTurn: 1,
  operatorPool: {
    rarities: [4, 5, 6],
    classes: [],
  },
};

export const rooms = pgTable(
  "rooms",
  {
    id: varchar("id", { length: 36 }).primaryKey(),
    code: varchar("code", { length: 16 }).notNull(),
    hostUserId: varchar("host_user_id", { length: 36 })
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: varchar("name", { length: 100 }).notNull(),
    passwordHash: varchar("password_hash", { length: 255 }),
    roomPassword: varchar("room_password", { length: 64 }),
    status: varchar("status", { length: 24 }).default("waiting").notNull(),
    settingsJson: jsonb("settings_json").$type<RoomSettings>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [
    uniqueIndex("rooms_code_unique").on(table.code),
    index("rooms_status_idx").on(table.status),
    index("rooms_host_user_id_idx").on(table.hostUserId),
  ],
);

export type Room = typeof rooms.$inferSelect;
export type NewRoom = typeof rooms.$inferInsert;
