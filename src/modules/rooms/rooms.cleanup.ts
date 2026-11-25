import { realtimeHub } from "../../websocket/hub";
import { gameEngine } from "../game/game.engine";
import { RoomsRepository } from "./rooms.repository";

const MINUTE_MS = 60 * 1000;

export const ROOM_CLEANUP_CONFIG = {
  emptyWaitingOrFinishedGraceMs: 10 * MINUTE_MS, // 10m
  emptyPlayingGraceMs: 10 * MINUTE_MS, // 10m
  finishedMaxIdleMs: 15 * MINUTE_MS, // 15m
  waitingMaxIdleMs: 30 * MINUTE_MS, // 30m
  playingMaxIdleMs: 120 * MINUTE_MS, // 2h
  sweepIntervalMs: 5 * MINUTE_MS, // 5m
  dbTouchThrottleMs: 60 * 1000, // 1m
} as const;

class RoomCleanupManager {
  private readonly emptyTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly lastActivityAt = new Map<string, number>();
  private readonly lastDbTouchAt = new Map<string, number>();
  private sweepHandle: ReturnType<typeof setInterval> | null = null;

  start() {
    if (this.sweepHandle) return;

    void this.sweepStaleRooms(true);
    this.sweepHandle = setInterval(() => {
      void this.sweepStaleRooms(false);
    }, ROOM_CLEANUP_CONFIG.sweepIntervalMs);
  }

  stop() {
    if (this.sweepHandle) {
      clearInterval(this.sweepHandle);
      this.sweepHandle = null;
    }
    for (const timer of this.emptyTimers.values()) {
      clearTimeout(timer);
    }
    this.emptyTimers.clear();
  }

  markActivity(roomId: string) {
    const now = Date.now();
    this.lastActivityAt.set(roomId, now);

    const lastTouch = this.lastDbTouchAt.get(roomId) ?? 0;
    if (now - lastTouch >= ROOM_CLEANUP_CONFIG.dbTouchThrottleMs) {
      this.lastDbTouchAt.set(roomId, now);
      void RoomsRepository.touchRoom(roomId).catch(() => {
        // Ignore if room was already deleted
      });
    }
  }

  onSocketSubscribed(roomId: string) {
    this.cancelEmptyTimer(roomId);
    this.markActivity(roomId);
  }

  async onRoomBecameEmpty(roomId: string) {
    if (realtimeHub.getOnlineUserIds(roomId).size > 0) return;

    const room = await RoomsRepository.findById(roomId);
    if (!room) {
      this.clearTracking(roomId);
      gameEngine.cleanupRoom(roomId);
      return;
    }

    const delayMs =
      room.status === "playing"
        ? ROOM_CLEANUP_CONFIG.emptyPlayingGraceMs
        : ROOM_CLEANUP_CONFIG.emptyWaitingOrFinishedGraceMs;

    this.scheduleEmptyCleanup(roomId, delayMs, `empty ${room.status} room`);
  }

  async purgeRoom(roomId: string, reason: string) {
    this.clearTracking(roomId);
    realtimeHub.broadcast(roomId, "ws:error", {
      message: "Room was closed due to inactivity.",
    });
    gameEngine.cleanupRoom(roomId);
    await RoomsRepository.deleteRoom(roomId);
    realtimeHub.broadcastRoomListUpdated();
    console.log(`[rooms:cleanup] Deleted room ${roomId} (${reason})`);
  }

  async sweepStaleRooms(isStartup = false) {
    try {
      const allRooms = await RoomsRepository.findAllForCleanup();
      const now = Date.now();

      for (const room of allRooms) {
        const onlineCount = realtimeHub.getOnlineUserIds(room.id).size;
        const lastActive = Math.max(
          room.updatedAt.getTime(),
          this.lastActivityAt.get(room.id) ?? 0,
        );
        const idleMs = Math.max(0, now - lastActive);

        if (onlineCount === 0) {
          const graceMs =
            room.status === "playing"
              ? ROOM_CLEANUP_CONFIG.emptyPlayingGraceMs
              : ROOM_CLEANUP_CONFIG.emptyWaitingOrFinishedGraceMs;

          if (idleMs >= graceMs) {
            await this.purgeRoom(
              room.id,
              isStartup
                ? `stale empty ${room.status} room on startup`
                : `empty ${room.status} room past grace period`,
            );
          } else if (!this.emptyTimers.has(room.id)) {
            this.scheduleEmptyCleanup(
              room.id,
              graceMs - idleMs,
              `empty ${room.status} room`,
            );
          }
          continue;
        }

        const maxIdleMs =
          room.status === "finished"
            ? ROOM_CLEANUP_CONFIG.finishedMaxIdleMs
            : room.status === "playing"
              ? ROOM_CLEANUP_CONFIG.playingMaxIdleMs
              : ROOM_CLEANUP_CONFIG.waitingMaxIdleMs;

        if (idleMs >= maxIdleMs) {
          await this.purgeRoom(room.id, `idle ${room.status} room timeout`);
        }
      }
    } catch (error) {
      console.error("[rooms:cleanup] Sweep failed:", error);
    }
  }

  private scheduleEmptyCleanup(roomId: string, delayMs: number, reason: string) {
    this.cancelEmptyTimer(roomId);
    const timer = setTimeout(() => {
      this.emptyTimers.delete(roomId);
      if (realtimeHub.getOnlineUserIds(roomId).size > 0) return;
      void this.purgeRoom(roomId, reason).catch((err) => {
        console.error(`[rooms:cleanup] Failed to purge room ${roomId}:`, err);
      });
    }, Math.max(1000, delayMs));
    this.emptyTimers.set(roomId, timer);
  }

  private cancelEmptyTimer(roomId: string) {
    const existing = this.emptyTimers.get(roomId);
    if (existing) {
      clearTimeout(existing);
      this.emptyTimers.delete(roomId);
    }
  }

  private clearTracking(roomId: string) {
    this.cancelEmptyTimer(roomId);
    this.lastActivityAt.delete(roomId);
    this.lastDbTouchAt.delete(roomId);
  }
}

export const roomCleanup = new RoomCleanupManager();
