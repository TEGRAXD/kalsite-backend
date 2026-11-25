import { Hono } from "hono";
import { count, eq } from "drizzle-orm";
import { db, operators, roles, users } from "../../database";
import { NotFoundError } from "../../errors";
import {
  requireAuth,
  requireSuperAdmin,
  type AuthVariables,
} from "../../middlewares/auth";
import { successResponse } from "../../utils/response";
import { roomCleanup } from "../rooms/rooms.cleanup";
import { RoomsRepository } from "../rooms/rooms.repository";
import { RoomsService } from "../rooms/rooms.service";

export const adminRoutes = new Hono<{ Variables: Partial<AuthVariables> }>();

adminRoutes.use("*", requireAuth, requireSuperAdmin);

// GET /admin/overview - dashboard summary stats + live rooms
adminRoutes.get("/overview", async (c) => {
  const [userCountRows, operatorCountRows, roleCountRows, activeRooms] =
    await Promise.all([
      db.select({ value: count() }).from(users),
      db
        .select({ value: count() })
        .from(operators)
        .where(eq(operators.isEnabled, true)),
      db.select({ value: count() }).from(roles),
      RoomsService.listRooms({}),
    ]);

  return c.json(
    successResponse("Admin overview retrieved", {
      counts: {
        users: userCountRows[0]?.value ?? 0,
        operators: operatorCountRows[0]?.value ?? 0,
        roles: roleCountRows[0]?.value ?? 0,
        activeRooms: activeRooms.length,
      },
      rooms: activeRooms,
    }),
  );
});

// DELETE /admin/rooms/:id - force-close an active room
adminRoutes.delete("/rooms/:id", async (c) => {
  const roomId = c.req.param("id").trim();
  const room = await RoomsRepository.findById(roomId);
  if (!room) {
    throw new NotFoundError("Room not found");
  }

  await roomCleanup.purgeRoom(room.id, "closed by super-administrator");
  return c.json(
    successResponse("Room closed successfully", {
      id: room.id,
      code: room.code,
    }),
  );
});
