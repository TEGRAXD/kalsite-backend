import type { WebSocketHandler } from "bun";
import type { RoomSettings } from "../database";
import { AppError } from "../errors";
import { gameEngine } from "../modules/game/game.engine";
import { roomCleanup } from "../modules/rooms/rooms.cleanup";
import { RoomsRepository } from "../modules/rooms/rooms.repository";
import { RoomsService } from "../modules/rooms/rooms.service";
import { chatLimiter, guessLimiter } from "../utils/rate-limit";
import { wsClientEventSchema } from "./events";
import { realtimeHub, type WsSocketData } from "./hub";

export function parseCookieHeader(
  header: string | null,
): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    const val = decodeURIComponent(part.slice(idx + 1).trim());
    if (key) out[key] = val;
  }
  return out;
}

export const websocketHandler: WebSocketHandler<WsSocketData> = {
  open(ws) {
    realtimeHub.send(ws, "ws:connected", {
      userId: ws.data.userId,
      username: ws.data.username,
    });
  },

  async message(ws, rawMessage) {
    let parsedJson: unknown;
    try {
      const text =
        typeof rawMessage === "string"
          ? rawMessage
          : new TextDecoder().decode(rawMessage);
      parsedJson = JSON.parse(text);
    } catch {
      realtimeHub.send(ws, "ws:error", { message: "Invalid JSON payload" });
      return;
    }

    const validated = wsClientEventSchema.safeParse(parsedJson);
    if (!validated.success) {
      realtimeHub.send(ws, "ws:error", {
        message: "Invalid WebSocket event payload",
        issues: validated.error.issues,
      });
      return;
    }

    const msg = validated.data;
    const displayName = ws.data.globalName || ws.data.username;

    try {
      if (msg.event === "room:subscribe") {
        const room = await RoomsRepository.findByCode(msg.payload.roomCode);
        if (!room) {
          realtimeHub.send(ws, "ws:error", { message: "Room not found" });
          return;
        }

        const membership = await RoomsRepository.findActiveMembership(
          room.id,
          ws.data.userId,
        );
        if (!membership) {
          realtimeHub.send(ws, "ws:error", {
            message: "Join the room before subscribing",
          });
          return;
        }

        realtimeHub.subscribe(ws, room.id, room.code);
        roomCleanup.onSocketSubscribed(room.id);

        const refreshed = await RoomsService.getRoomByCode(room.code, {
          id: ws.data.userId,
          discordId: "",
          username: ws.data.username,
          globalName: ws.data.globalName,
          avatar: ws.data.avatar,
          createdAt: new Date(),
        });

        realtimeHub.broadcastRoomUpdated(refreshed.room);

        if (room.status !== "waiting") {
          await gameEngine.ensureLoaded(
            room.id,
            room.code,
            room.settingsJson as RoomSettings,
          );
          const personalized = gameEngine.getPersonalizedState(
            room.id,
            ws.data.userId,
          );
          if (personalized) {
            realtimeHub.send(ws, "game:state", personalized);
          }
        }
        return;
      }

      const roomId = ws.data.roomId;
      if (!roomId) {
        realtimeHub.send(ws, "ws:error", {
          message: "Not subscribed to any room",
        });
        return;
      }

      roomCleanup.markActivity(roomId);

      switch (msg.event) {
        case "room:color": {
          await RoomsService.setMemberColor(
            {
              id: ws.data.userId,
              discordId: "",
              username: ws.data.username,
              globalName: ws.data.globalName,
              avatar: ws.data.avatar,
              createdAt: new Date(),
            },
            roomId,
            msg.payload.color,
          );
          break;
        }

        case "room:ready": {
          await RoomsService.toggleReady(
            {
              id: ws.data.userId,
              discordId: "",
              username: ws.data.username,
              globalName: ws.data.globalName,
              avatar: ws.data.avatar,
              createdAt: new Date(),
            },
            roomId,
            msg.payload.ready,
          );
          break;
        }

        case "room:chat": {
          const check = chatLimiter.consume(`${ws.data.userId}:chat`);
          if (!check.allowed) {
            realtimeHub.send(ws, "ws:error", {
              message: "Chat rate limit reached. Wait a moment.",
            });
            return;
          }
          await gameEngine.handleChat(
            roomId,
            { userId: ws.data.userId, displayName },
            msg.payload.message,
          );
          break;
        }

        case "room:spectator-chat": {
          const check = chatLimiter.consume(`${ws.data.userId}:spec_chat`);
          if (!check.allowed) {
            realtimeHub.send(ws, "ws:error", {
              message: "Chat rate limit reached. Wait a moment.",
            });
            return;
          }
          await gameEngine.handleSpectatorChat(
            roomId,
            { userId: ws.data.userId, displayName },
            msg.payload.message,
          );
          break;
        }

        case "room:clue": {
          const check = chatLimiter.consume(`${ws.data.userId}:clue`);
          if (!check.allowed) {
            realtimeHub.send(ws, "ws:error", {
              message: "Sending clues too fast. Wait a moment.",
            });
            return;
          }
          await gameEngine.handleClue(
            roomId,
            { userId: ws.data.userId, displayName },
            msg.payload,
          );
          break;
        }

        case "game:ask": {
          await gameEngine.handleAsk(
            roomId,
            { userId: ws.data.userId, displayName },
            msg.payload.question,
          );
          break;
        }

        case "game:answer": {
          await gameEngine.handleAnswer(
            roomId,
            { userId: ws.data.userId, displayName },
            msg.payload.questionId,
            msg.payload.answer,
          );
          break;
        }

        case "game:reaction": {
          const check = chatLimiter.consume(`${ws.data.userId}:reaction`);
          if (!check.allowed) return;
          await gameEngine.handleReaction(
            roomId,
            { userId: ws.data.userId, displayName },
            msg.payload.reaction,
          );
          break;
        }

        case "game:guess": {
          const check = guessLimiter.consume(`${ws.data.userId}:guess`);
          if (!check.allowed) {
            realtimeHub.send(ws, "ws:error", {
              message: "Guessing too rapidly. Slow down.",
            });
            return;
          }
          await gameEngine.handleGuess(
            roomId,
            { userId: ws.data.userId, displayName },
            msg.payload.operatorId,
            msg.payload.clientActionId,
          );
          break;
        }

        case "game:pass": {
          await gameEngine.handlePass(
            roomId,
            { userId: ws.data.userId, displayName },
            msg.payload.clientActionId,
          );
          break;
        }
      }
    } catch (error) {
      const message =
        error instanceof AppError
          ? error.message
          : "An unexpected server error occurred";
      realtimeHub.send(ws, "ws:error", { message });
    }
  },

  async close(ws) {
    const roomId = ws.data.roomId;
    const roomCode = ws.data.roomCode;
    realtimeHub.unsubscribe(ws);
    if (roomId && realtimeHub.getOnlineUserIds(roomId).size === 0) {
      void roomCleanup.onRoomBecameEmpty(roomId);
    }
    if (roomCode) {
      try {
        const room = await RoomsService.getRoomDetailForMembers(roomCode);
        realtimeHub.broadcastRoomUpdated(room);
      } catch {
        // Room may have been deleted
      }
    }
  },
};
