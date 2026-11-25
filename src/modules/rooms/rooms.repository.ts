import { and, asc, desc, eq, ilike, isNull, or } from "drizzle-orm";
import { db, rooms, roomMembers, type RoomSettings } from "../../database";

export const RoomsRepository = {
  async findMany(filter: {
    search?: string;
    status?: string;
    page?: number;
    limit?: number;
  }) {
    const page = Math.max(1, filter.page ?? 1);
    const limit = Math.min(50, Math.max(1, filter.limit ?? 20));
    const offset = (page - 1) * limit;

    const conditions = [];
    if (filter.search) {
      const pattern = `%${filter.search}%`;
      conditions.push(
        or(ilike(rooms.name, pattern), ilike(rooms.code, pattern))!,
      );
    }
    if (filter.status && filter.status !== "all") {
      conditions.push(eq(rooms.status, filter.status));
    }

    return db.query.rooms.findMany({
      where: conditions.length > 0 ? and(...conditions) : undefined,
      orderBy: [desc(rooms.createdAt)],
      limit,
      offset,
      with: {
        host: true,
        members: {
          where: isNull(roomMembers.leftAt),
          orderBy: [asc(roomMembers.joinedAt), asc(roomMembers.id)],
          with: { user: true },
        },
      },
    });
  },

  findByCode(code: string) {
    return db.query.rooms.findFirst({
      where: eq(rooms.code, code.toUpperCase()),
      with: {
        host: true,
        members: {
          where: isNull(roomMembers.leftAt),
          orderBy: [asc(roomMembers.joinedAt), asc(roomMembers.id)],
          with: { user: true },
        },
      },
    });
  },

  findById(id: string) {
    return db.query.rooms.findFirst({
      where: eq(rooms.id, id),
      with: {
        host: true,
        members: {
          where: isNull(roomMembers.leftAt),
          orderBy: [asc(roomMembers.joinedAt), asc(roomMembers.id)],
          with: { user: true },
        },
      },
    });
  },

  async create(data: {
    id: string;
    code: string;
    hostUserId: string;
    name: string;
    passwordHash: string | null;
    roomPassword: string | null;
    settings: RoomSettings;
  }) {
    await db.insert(rooms).values({
      id: data.id,
      code: data.code,
      hostUserId: data.hostUserId,
      name: data.name,
      passwordHash: data.passwordHash,
      roomPassword: data.roomPassword,
      status: "waiting",
      settingsJson: data.settings,
    });
    return this.findById(data.id);
  },

  async addMember(data: {
    roomId: string;
    userId: string;
    role: "host" | "player" | "spectator";
    color: string;
    isReady?: boolean;
  }) {
    const id = crypto.randomUUID();
    await db.insert(roomMembers).values({
      id,
      roomId: data.roomId,
      userId: data.userId,
      role: data.role,
      color: data.color,
      isReady: data.isReady ?? false,
    });
    return id;
  },

  async findActiveMembership(roomId: string, userId: string) {
    return db.query.roomMembers.findFirst({
      where: and(
        eq(roomMembers.roomId, roomId),
        eq(roomMembers.userId, userId),
        isNull(roomMembers.leftAt),
      ),
    });
  },

  async setMemberReady(roomId: string, userId: string, isReady: boolean) {
    await db
      .update(roomMembers)
      .set({ isReady })
      .where(
        and(
          eq(roomMembers.roomId, roomId),
          eq(roomMembers.userId, userId),
          isNull(roomMembers.leftAt),
        ),
      );
  },

  async setMemberColor(roomId: string, userId: string, color: string) {
    await db
      .update(roomMembers)
      .set({ color })
      .where(
        and(
          eq(roomMembers.roomId, roomId),
          eq(roomMembers.userId, userId),
          isNull(roomMembers.leftAt),
        ),
      );
  },

  async markMemberLeft(roomId: string, userId: string) {
    await db
      .update(roomMembers)
      .set({ leftAt: new Date(), isReady: false })
      .where(
        and(
          eq(roomMembers.roomId, roomId),
          eq(roomMembers.userId, userId),
          isNull(roomMembers.leftAt),
        ),
      );
  },

  async updateHost(roomId: string, newHostUserId: string) {
    await db
      .update(rooms)
      .set({ hostUserId: newHostUserId })
      .where(eq(rooms.id, roomId));

    await db
      .update(roomMembers)
      .set({ role: "host" })
      .where(
        and(
          eq(roomMembers.roomId, roomId),
          eq(roomMembers.userId, newHostUserId),
          isNull(roomMembers.leftAt),
        ),
      );
  },

  async resetAllReady(roomId: string, hostUserId?: string) {
    await db
      .update(roomMembers)
      .set({ isReady: false })
      .where(and(eq(roomMembers.roomId, roomId), isNull(roomMembers.leftAt)));

    if (hostUserId) {
      await db
        .update(roomMembers)
        .set({ isReady: true })
        .where(
          and(
            eq(roomMembers.roomId, roomId),
            eq(roomMembers.userId, hostUserId),
            isNull(roomMembers.leftAt),
          ),
        );
    }
  },

  async removeSpectators(roomId: string) {
    await db
      .update(roomMembers)
      .set({ leftAt: new Date(), isReady: false })
      .where(
        and(
          eq(roomMembers.roomId, roomId),
          eq(roomMembers.role, "spectator"),
          isNull(roomMembers.leftAt),
        ),
      );
  },

  async setStatus(roomId: string, status: "waiting" | "playing" | "finished") {
    await db
      .update(rooms)
      .set({ status, updatedAt: new Date() })
      .where(eq(rooms.id, roomId));
  },

  async updateSettings(
    roomId: string,
    data: {
      name: string;
      passwordHash: string | null;
      roomPassword: string | null;
      settingsJson: RoomSettings;
    },
  ) {
    await db
      .update(rooms)
      .set({
        name: data.name,
        passwordHash: data.passwordHash,
        roomPassword: data.roomPassword,
        settingsJson: data.settingsJson,
        updatedAt: new Date(),
      })
      .where(eq(rooms.id, roomId));
  },

  async touchRoom(roomId: string) {
    await db
      .update(rooms)
      .set({ updatedAt: new Date() })
      .where(eq(rooms.id, roomId));
  },

  async findAllForCleanup() {
    return db
      .select({
        id: rooms.id,
        code: rooms.code,
        status: rooms.status,
        updatedAt: rooms.updatedAt,
      })
      .from(rooms);
  },

  async deleteRoom(roomId: string) {
    await db.delete(rooms).where(eq(rooms.id, roomId));
  },
};
