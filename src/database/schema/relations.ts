import { relations } from "drizzle-orm";
import { users } from "./users";
import { sessions } from "./sessions";
import { rooms } from "./rooms";
import { roomMembers } from "./room-members";
import { games } from "./games";
import { gamePlayers } from "./game-players";
import { gameEvents } from "./game-events";
import { operators } from "./operators";

export const usersRelations = relations(users, ({ many }) => ({
  sessions: many(sessions),
  hostedRooms: many(rooms),
  roomMemberships: many(roomMembers),
  gamePlayers: many(gamePlayers),
  gameEvents: many(gameEvents),
}));

export const sessionsRelations = relations(sessions, ({ one }) => ({
  user: one(users, {
    fields: [sessions.userId],
    references: [users.id],
  }),
}));

export const roomsRelations = relations(rooms, ({ one, many }) => ({
  host: one(users, {
    fields: [rooms.hostUserId],
    references: [users.id],
  }),
  members: many(roomMembers),
  games: many(games),
}));

export const roomMembersRelations = relations(roomMembers, ({ one }) => ({
  room: one(rooms, {
    fields: [roomMembers.roomId],
    references: [rooms.id],
  }),
  user: one(users, {
    fields: [roomMembers.userId],
    references: [users.id],
  }),
}));

export const gamesRelations = relations(games, ({ one, many }) => ({
  room: one(rooms, {
    fields: [games.roomId],
    references: [rooms.id],
  }),
  players: many(gamePlayers),
  events: many(gameEvents),
}));

export const gamePlayersRelations = relations(gamePlayers, ({ one }) => ({
  game: one(games, {
    fields: [gamePlayers.gameId],
    references: [games.id],
  }),
  user: one(users, {
    fields: [gamePlayers.userId],
    references: [users.id],
  }),
  operator: one(operators, {
    fields: [gamePlayers.operatorId],
    references: [operators.id],
  }),
}));

export const gameEventsRelations = relations(gameEvents, ({ one }) => ({
  game: one(games, {
    fields: [gameEvents.gameId],
    references: [games.id],
  }),
  user: one(users, {
    fields: [gameEvents.userId],
    references: [users.id],
  }),
}));

export const operatorsRelations = relations(operators, ({ many }) => ({
  gamePlayers: many(gamePlayers),
}));
