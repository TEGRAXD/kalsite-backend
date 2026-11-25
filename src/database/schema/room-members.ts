import {
  pgTable,
  varchar,
  boolean,
  timestamp,
  index,
} from "drizzle-orm/pg-core";
import { rooms } from "./rooms";
import { users } from "./users";

export const roomMembers = pgTable(
  "room_members",
  {
    id: varchar("id", { length: 36 }).primaryKey(),
    roomId: varchar("room_id", { length: 36 })
      .notNull()
      .references(() => rooms.id, { onDelete: "cascade" }),
    userId: varchar("user_id", { length: 36 })
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: varchar("role", { length: 24 }).default("player").notNull(),
    color: varchar("color", { length: 16 }).default("#34d399").notNull(),
    isReady: boolean("is_ready").default(false).notNull(),
    joinedAt: timestamp("joined_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    leftAt: timestamp("left_at", { withTimezone: true }),
  },
  (table) => [
    index("room_members_room_id_idx").on(table.roomId),
    index("room_members_user_id_idx").on(table.userId),
  ],
);

export type RoomMember = typeof roomMembers.$inferSelect;
export type NewRoomMember = typeof roomMembers.$inferInsert;
