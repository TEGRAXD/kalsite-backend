import type { ServerWebSocket } from "bun";
import type { RoomDetail, PersonalizedGameState } from "../modules/game/game.types";

export interface WsSocketData {
  userId: string;
  username: string;
  globalName: string | null;
  avatar: string | null;
  roomId: string | null;
  roomCode: string | null;
}

export type KalsiteSocket = ServerWebSocket<WsSocketData>;

class RealtimeHub {
  // roomId -> Set of sockets
  private readonly rooms = new Map<string, Set<KalsiteSocket>>();
  // Sockets currently viewing the room browser list
  private readonly roomListSubscribers = new Set<KalsiteSocket>();

  subscribeRoomList(ws: KalsiteSocket) {
    if (ws.data.roomId) {
      this.unsubscribe(ws);
    }
    this.roomListSubscribers.add(ws);
  }

  unsubscribeRoomList(ws: KalsiteSocket) {
    this.roomListSubscribers.delete(ws);
  }

  broadcastRoomListUpdated() {
    if (this.roomListSubscribers.size === 0) return;
    const raw = JSON.stringify({ event: "rooms:list-updated", payload: {} });
    for (const ws of this.roomListSubscribers) {
      try {
        ws.send(raw);
      } catch {
        // Ignore broken sockets
      }
    }
  }

  subscribe(ws: KalsiteSocket, roomId: string, roomCode: string) {
    this.roomListSubscribers.delete(ws);
    if (ws.data.roomId && ws.data.roomId !== roomId) {
      this.unsubscribe(ws);
    }

    ws.data.roomId = roomId;
    ws.data.roomCode = roomCode;

    let set = this.rooms.get(roomId);
    if (!set) {
      set = new Set();
      this.rooms.set(roomId, set);
    }
    set.add(ws);
  }

  unsubscribe(ws: KalsiteSocket) {
    const roomId = ws.data.roomId;
    if (!roomId) return;

    const set = this.rooms.get(roomId);
    if (set) {
      set.delete(ws);
      if (set.size === 0) {
        this.rooms.delete(roomId);
      }
    }

    ws.data.roomId = null;
    ws.data.roomCode = null;
  }

  getOnlineUserIds(roomId: string): Set<string> {
    const set = this.rooms.get(roomId);
    const ids = new Set<string>();
    if (!set) return ids;
    for (const ws of set) {
      ids.add(ws.data.userId);
    }
    return ids;
  }

  send(ws: KalsiteSocket, event: string, payload: unknown) {
    try {
      ws.send(JSON.stringify({ event, payload }));
    } catch {
      // Socket closed mid-send
    }
  }

  sendToUsers(
    roomId: string,
    userIds: Set<string>,
    event: string,
    payload: unknown,
    unsubscribeAfter = false,
  ) {
    const set = this.rooms.get(roomId);
    if (!set || userIds.size === 0) return;
    const raw = JSON.stringify({ event, payload });
    for (const ws of Array.from(set)) {
      if (!userIds.has(ws.data.userId)) continue;
      try {
        ws.send(raw);
      } catch {
        // Ignore broken sockets
      }
      if (unsubscribeAfter) {
        this.unsubscribe(ws);
      }
    }
  }

  broadcast(roomId: string, event: string, payload: unknown) {
    const set = this.rooms.get(roomId);
    if (!set) return;
    const raw = JSON.stringify({ event, payload });
    for (const ws of set) {
      try {
        ws.send(raw);
      } catch {
        // Ignore broken sockets
      }
    }
  }

  broadcastRoomUpdated(room: RoomDetail) {
    const online = this.getOnlineUserIds(room.id);
    const enriched: RoomDetail = {
      ...room,
      members: room.members.map((m) => ({
        ...m,
        isOnline: online.has(m.userId),
      })),
    };
    this.broadcast(room.id, "room:updated", enriched);
  }

  /**
   * CRITICAL SECURITY INVARIANT:
   * Never broadcast the full Operator assignment map.
   * Each socket receives a personalized state payload where their own Operator
   * is stripped (`operator: null`, `operatorHidden: true`) until reveal/end.
   */
  broadcastPersonalizedGameState(
    roomId: string,
    event: "game:started" | "game:state" | "game:ended",
    buildStateForUser: (viewerUserId: string) => PersonalizedGameState | null,
  ) {
    const set = this.rooms.get(roomId);
    if (!set) return;
    for (const ws of set) {
      const state = buildStateForUser(ws.data.userId);
      if (state) {
        this.send(ws, event, state);
      }
    }
  }
}

export const realtimeHub = new RealtimeHub();
