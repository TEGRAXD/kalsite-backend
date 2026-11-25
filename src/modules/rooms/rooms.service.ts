import type { RoomSettings, User } from "../../database";
import {
  BadRequestError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
  TooManyRequestsError,
} from "../../errors";
import { generateRoomCode } from "../../utils/code";
import { hashPassword, verifyPassword } from "../../utils/password";
import {
  roomCreateLimiter,
  roomJoinPasswordLimiter,
} from "../../utils/rate-limit";
import { realtimeHub } from "../../websocket/hub";
import { gameEngine } from "../game/game.engine";
import type { RoomDetail, RoomSummary } from "../game/game.types";
import { roomCleanup } from "./rooms.cleanup";
import {
  isValidPlayerColor,
  pickRandomAvailableColor,
} from "./rooms.colors";
import { RoomsRepository } from "./rooms.repository";
import type {
  CreateRoomInput,
  JoinRoomInput,
  UpdateRoomSettingsInput,
} from "./rooms.schema";

type RepoRoom = NonNullable<Awaited<ReturnType<typeof RoomsRepository.findById>>>;

function formatRoomSummary(room: RepoRoom): RoomSummary {
  const settings = room.settingsJson as RoomSettings;
  return {
    id: room.id,
    code: room.code,
    name: room.name,
    hostUserId: room.hostUserId,
    hostName: room.host.globalName || room.host.username,
    status: room.status,
    hasPassword: Boolean(room.passwordHash),
    playerCount: room.members.length,
    maxPlayers: settings.maxPlayers,
    settings,
    createdAt: room.createdAt.toISOString(),
  };
}

function formatRoomDetail(room: RepoRoom, includePassword = false): RoomDetail {
  const online = realtimeHub.getOnlineUserIds(room.id);
  const liveGame = gameEngine.getLiveGame(room.id);
  return {
    ...formatRoomSummary(room),
    activeGameId: liveGame?.gameId ?? null,
    ...(includePassword ? { roomPassword: room.roomPassword ?? null } : {}),
    members: room.members.map((m) => ({
      userId: m.userId,
      username: m.user.username,
      globalName: m.user.globalName,
      avatar: m.user.avatar,
      role: m.role,
      color: m.color,
      isReady: m.isReady,
      isOnline: online.has(m.userId),
    })),
  };
}

export const RoomsService = {
  async listRooms(filter: { search?: string; status?: string; page?: number }) {
    const rows = await RoomsRepository.findMany(filter);
    return rows.map((r) => formatRoomSummary(r));
  },

  async getRoomDetailForMembers(code: string): Promise<RoomDetail> {
    const room = await RoomsRepository.findByCode(code);
    if (!room) {
      throw new NotFoundError("Room not found");
    }
    return formatRoomDetail(room, true);
  },

  async getRoomByCode(code: string, viewer?: User) {
    const room = await RoomsRepository.findByCode(code);
    if (!room) {
      throw new NotFoundError("Room not found");
    }

    const isMember = Boolean(
      viewer && room.members.some((m) => m.userId === viewer.id),
    );
    const detail = formatRoomDetail(room, isMember);
    let gameState = null;

    if (viewer && isMember && room.status !== "waiting") {
      await gameEngine.ensureLoaded(
        room.id,
        room.code,
        room.settingsJson as RoomSettings,
      );
      gameState = gameEngine.getPersonalizedState(room.id, viewer.id);
    }

    return {
      room: detail,
      gameState,
      lobbyFeed: gameEngine.getLobbyFeed(room.id),
    };
  },

  async createRoom(user: User, input: CreateRoomInput) {
    const limit = roomCreateLimiter.consume(user.id);
    if (!limit.allowed) {
      throw new TooManyRequestsError("You are creating rooms too quickly.");
    }

    let code = generateRoomCode();
    for (let attempt = 0; attempt < 5; attempt++) {
      const exists = await RoomsRepository.findByCode(code);
      if (!exists) break;
      code = generateRoomCode();
    }

    const passwordHash = input.password
      ? await hashPassword(input.password)
      : null;

    const settings: RoomSettings = {
      maxPlayers: input.maxPlayers,
      lives: input.lives,
      turnTimerSeconds: input.turnTimerSeconds ?? null,
      allowPass: input.allowPass,
      maxQuestionsPerTurn: input.maxQuestionsPerTurn,
      operatorPool: {
        rarities: input.rarities.length > 0 ? input.rarities : [4, 5, 6],
        classes: input.classes,
      },
    };

    const roomId = crypto.randomUUID();
    await RoomsRepository.create({
      id: roomId,
      code,
      hostUserId: user.id,
      name: input.name,
      passwordHash,
      roomPassword: input.password || null,
      settings,
    });

    await RoomsRepository.addMember({
      roomId,
      userId: user.id,
      role: "host",
      color: pickRandomAvailableColor([]),
      isReady: true,
    });

    const created = await RoomsRepository.findById(roomId);
    roomCleanup.markActivity(roomId);
    void roomCleanup.onRoomBecameEmpty(roomId);
    realtimeHub.broadcastRoomListUpdated();
    return formatRoomDetail(created!, true);
  },

  async joinRoom(user: User, code: string, input: JoinRoomInput) {
    const room = await RoomsRepository.findByCode(code);
    if (!room) {
      throw new NotFoundError("Room not found");
    }

    const existing = await RoomsRepository.findActiveMembership(
      room.id,
      user.id,
    );
    if (existing) {
      return formatRoomDetail(room, true);
    }

    if (room.passwordHash) {
      const limit = roomJoinPasswordLimiter.consume(`${user.id}:${room.id}`);
      if (!limit.allowed) {
        throw new TooManyRequestsError(
          "Too many password attempts. Please wait a minute.",
        );
      }

      if (!input.password) {
        throw new ForbiddenError("Password required to join this room");
      }

      const valid = await verifyPassword(input.password, room.passwordHash);
      if (!valid) {
        throw new ForbiddenError("Incorrect room password");
      }
    }

    if (room.status === "finished") {
      throw new BadRequestError(
        "Match already finished. Wait for players to return to lobby.",
      );
    }

    const settings = room.settingsJson as RoomSettings;
    if (room.members.length >= settings.maxPlayers) {
      throw new ConflictError("Room is already full");
    }

    const role = room.status === "playing" ? "spectator" : "player";
    const assignedColor = pickRandomAvailableColor(
      room.members.map((m) => m.color),
    );
    await RoomsRepository.addMember({
      roomId: room.id,
      userId: user.id,
      role,
      color: assignedColor,
      isReady: false,
    });

    const updated = await RoomsRepository.findById(room.id);
    const detail = formatRoomDetail(updated!, true);
    roomCleanup.markActivity(room.id);

    realtimeHub.broadcast(room.id, "room:member-joined", {
      userId: user.id,
      username: user.username,
      globalName: user.globalName,
      role,
    });
    realtimeHub.broadcastRoomUpdated(detail);
    realtimeHub.broadcastRoomListUpdated();

    return detail;
  },

  async leaveRoom(user: User, roomId: string) {
    const room = await RoomsRepository.findById(roomId);
    if (!room) {
      throw new NotFoundError("Room not found");
    }

    await RoomsRepository.markMemberLeft(room.id, user.id);

    const updated = await RoomsRepository.findById(room.id);
    if (!updated) return null;

    if (updated.members.length === 0) {
      await roomCleanup.purgeRoom(room.id, "all members left");
      return null;
    }

    if (updated.hostUserId === user.id) {
      const nextHost = updated.members[0]!;
      await RoomsRepository.updateHost(room.id, nextHost.userId);
    }

    const finalRoom = await RoomsRepository.findById(room.id);
    if (!finalRoom) return null;

    const detail = formatRoomDetail(finalRoom, true);
    realtimeHub.broadcast(room.id, "room:member-left", {
      userId: user.id,
      username: user.username,
    });
    realtimeHub.broadcastRoomUpdated(detail);
    realtimeHub.broadcastRoomListUpdated();

    return detail;
  },

  async updateSettings(
    user: User,
    roomId: string,
    input: UpdateRoomSettingsInput,
  ) {
    const room = await RoomsRepository.findById(roomId);
    if (!room) {
      throw new NotFoundError("Room not found");
    }

    if (room.hostUserId !== user.id) {
      throw new ForbiddenError("Only the room host can update settings");
    }

    if (room.status === "playing") {
      throw new BadRequestError(
        "Cannot change settings while a match is in progress",
      );
    }

    const currentSettings = room.settingsJson as RoomSettings;
    const nextMaxPlayers = input.maxPlayers ?? currentSettings.maxPlayers;
    if (nextMaxPlayers < room.members.length) {
      throw new BadRequestError(
        `Player limit cannot be lower than current players (${room.members.length})`,
      );
    }

    let nextPasswordHash = room.passwordHash;
    let nextRoomPassword = room.roomPassword;
    if (input.password !== undefined) {
      const trimmed = input.password.trim();
      if (trimmed.length === 0) {
        nextPasswordHash = null;
        nextRoomPassword = null;
      } else if (trimmed !== room.roomPassword) {
        nextPasswordHash = await hashPassword(trimmed);
        nextRoomPassword = trimmed;
      }
    }

    const nextSettings: RoomSettings = {
      maxPlayers: nextMaxPlayers,
      lives: input.lives ?? currentSettings.lives,
      turnTimerSeconds:
        input.turnTimerSeconds !== undefined
          ? input.turnTimerSeconds
          : currentSettings.turnTimerSeconds,
      allowPass: input.allowPass ?? currentSettings.allowPass,
      maxQuestionsPerTurn:
        input.maxQuestionsPerTurn ?? currentSettings.maxQuestionsPerTurn,
      operatorPool: {
        rarities:
          input.rarities && input.rarities.length > 0
            ? input.rarities
            : currentSettings.operatorPool.rarities,
        classes: input.classes ?? currentSettings.operatorPool.classes,
      },
    };

    await RoomsRepository.updateSettings(room.id, {
      name: input.name ?? room.name,
      passwordHash: nextPasswordHash,
      roomPassword: nextRoomPassword,
      settingsJson: nextSettings,
    });

    roomCleanup.markActivity(room.id);

    const updated = await RoomsRepository.findById(room.id);
    const detail = formatRoomDetail(updated!, true);
    realtimeHub.broadcastRoomUpdated(detail);
    realtimeHub.broadcastRoomListUpdated();
    return detail;
  },

  async setMemberColor(user: User, roomId: string, rawColor: string) {
    const color = rawColor.trim().toLowerCase();
    if (!isValidPlayerColor(color)) {
      throw new BadRequestError("Invalid player color selection");
    }

    const room = await RoomsRepository.findById(roomId);
    if (!room) {
      throw new NotFoundError("Room not found");
    }

    if (room.status === "playing") {
      throw new BadRequestError("Cannot change color during an active match");
    }

    const member = room.members.find((m) => m.userId === user.id);
    if (!member) {
      throw new ForbiddenError("You are not a member of this room");
    }

    const takenByOther = room.members.find(
      (m) => m.userId !== user.id && m.color.toLowerCase() === color,
    );
    if (takenByOther) {
      throw new ConflictError("That color is already taken by another player");
    }

    await RoomsRepository.setMemberColor(room.id, user.id, color);
    roomCleanup.markActivity(room.id);

    const updated = await RoomsRepository.findById(room.id);
    const detail = formatRoomDetail(updated!, true);
    realtimeHub.broadcastRoomUpdated(detail);
    return detail;
  },

  async toggleReady(user: User, roomId: string, ready: boolean) {
    const room = await RoomsRepository.findById(roomId);
    if (!room) {
      throw new NotFoundError("Room not found");
    }

    const member = await RoomsRepository.findActiveMembership(room.id, user.id);
    if (!member) {
      throw new ForbiddenError("You are not a member of this room");
    }

    await RoomsRepository.setMemberReady(room.id, user.id, ready);
    roomCleanup.markActivity(room.id);

    const updated = await RoomsRepository.findById(room.id);
    const detail = formatRoomDetail(updated!, true);
    realtimeHub.broadcastRoomUpdated(detail);
    return detail;
  },

  async startGame(
    user: User,
    roomId: string,
    options?: { force?: boolean },
  ) {
    const room = await RoomsRepository.findById(roomId);
    if (!room) {
      throw new NotFoundError("Room not found");
    }

    if (room.hostUserId !== user.id) {
      throw new ForbiddenError("Only the room host can start the game");
    }

    if (room.status === "playing") {
      throw new BadRequestError("A game is already in progress");
    }

    const activePlayers = room.members
      .filter((m) => m.role !== "spectator")
      .map((m) => ({
        userId: m.userId,
        username: m.user.username,
        globalName: m.user.globalName,
        avatar: m.user.avatar,
        color: m.color,
      }));

    if (activePlayers.length < 2) {
      throw new BadRequestError("At least 2 players must be in the lobby to start");
    }

    if (!options?.force) {
      const unreadyPlayer = room.members.find(
        (m) =>
          m.role !== "spectator" &&
          m.userId !== room.hostUserId &&
          !m.isReady,
      );
      if (unreadyPlayer) {
        throw new BadRequestError(
          "All players must be ready before starting the match",
        );
      }
    }

    await gameEngine.startGame({
      roomId: room.id,
      roomCode: room.code,
      settings: room.settingsJson as RoomSettings,
      members: activePlayers,
    });

    const refreshed = await RoomsRepository.findById(room.id);
    const detail = formatRoomDetail(refreshed!, true);
    roomCleanup.markActivity(room.id);
    realtimeHub.broadcastRoomUpdated(detail);
    realtimeHub.broadcastRoomListUpdated();

    return {
      room: detail,
      gameState: gameEngine.getPersonalizedState(room.id, user.id),
    };
  },

  async rematch(user: User, roomId: string) {
    const room = await RoomsRepository.findById(roomId);
    if (!room) {
      throw new NotFoundError("Room not found");
    }

    if (room.hostUserId !== user.id) {
      throw new ForbiddenError("Only the host can initiate a rematch");
    }

    const activePlayers = room.members
      .filter((m) => m.role !== "spectator")
      .map((m) => ({
        userId: m.userId,
        username: m.user.username,
        globalName: m.user.globalName,
        avatar: m.user.avatar,
        color: m.color,
      }));

    if (activePlayers.length < 2) {
      throw new BadRequestError("At least 2 players are needed for a rematch");
    }

    await RoomsRepository.resetAllReady(room.id, room.hostUserId);

    await gameEngine.startGame({
      roomId: room.id,
      roomCode: room.code,
      settings: room.settingsJson as RoomSettings,
      members: activePlayers,
    });

    const refreshed = await RoomsRepository.findById(room.id);
    const detail = formatRoomDetail(refreshed!, true);
    roomCleanup.markActivity(room.id);
    realtimeHub.broadcastRoomUpdated(detail);
    realtimeHub.broadcastRoomListUpdated();

    return {
      room: detail,
      gameState: gameEngine.getPersonalizedState(room.id, user.id),
    };
  },

  async returnToLobby(user: User, roomId: string) {
    const room = await RoomsRepository.findById(roomId);
    if (!room) {
      throw new NotFoundError("Room not found");
    }

    if (room.status === "playing") {
      throw new BadRequestError("Cannot return to lobby while a match is active");
    }

    const member = room.members.find((m) => m.userId === user.id);
    if (!member) {
      throw new ForbiddenError("You are not a member of this room");
    }

    if (member.role === "spectator") {
      throw new ForbiddenError("Spectators cannot return to the lobby");
    }

    const spectatorIds = new Set(
      room.members
        .filter((m) => m.role === "spectator")
        .map((m) => m.userId),
    );

    if (spectatorIds.size > 0) {
      await RoomsRepository.removeSpectators(room.id);
      realtimeHub.sendToUsers(
        room.id,
        spectatorIds,
        "room:spectator-exit",
        {
          reason: "Match ended and players returned to lobby.",
        },
        true,
      );
    }

    await RoomsRepository.setStatus(room.id, "waiting");
    await RoomsRepository.resetAllReady(room.id, room.hostUserId);
    gameEngine.clearLiveGame(room.id);
    roomCleanup.markActivity(room.id);

    const refreshed = await RoomsRepository.findById(room.id);
    const detail = formatRoomDetail(refreshed!, true);

    realtimeHub.broadcast(room.id, "room:returned-to-lobby", { room: detail });
    realtimeHub.broadcastRoomUpdated(detail);
    realtimeHub.broadcastRoomListUpdated();

    return { room: detail };
  },
};
