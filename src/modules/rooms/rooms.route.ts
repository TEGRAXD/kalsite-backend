import { Hono } from "hono";
import {
  optionalAuth,
  requireAuth,
  type AuthVariables,
} from "../../middlewares/auth";
import { validateBody } from "../../middlewares/validator";
import { successResponse } from "../../utils/response";
import {
  createRoomSchema,
  joinRoomSchema,
  updateRoomSettingsSchema,
} from "./rooms.schema";
import { RoomsService } from "./rooms.service";

export const roomsRoutes = new Hono<{ Variables: Partial<AuthVariables> }>();

roomsRoutes.get("/", async (c) => {
  const search = c.req.query("search")?.trim() || undefined;
  const status = c.req.query("status")?.trim() || undefined;
  const pageParam = c.req.query("page");
  const page = pageParam ? Number.parseInt(pageParam, 10) : 1;

  const list = await RoomsService.listRooms({
    search,
    status,
    page: Number.isNaN(page) ? 1 : page,
  });

  return c.json(successResponse("Rooms retrieved successfully", list));
});

roomsRoutes.get("/:code", optionalAuth, async (c) => {
  const code = c.req.param("code");
  const viewer = c.get("user");
  const result = await RoomsService.getRoomByCode(code, viewer);
  return c.json(successResponse("Room retrieved successfully", result));
});

roomsRoutes.post("/", requireAuth, validateBody(createRoomSchema), async (c) => {
  const user = c.get("user")!;
  const room = await RoomsService.createRoom(user, c.req.valid("json"));
  return c.json(successResponse("Room created successfully", room), 201);
});

roomsRoutes.post(
  "/:code/join",
  requireAuth,
  validateBody(joinRoomSchema),
  async (c) => {
    const user = c.get("user")!;
    const code = c.req.param("code");
    const room = await RoomsService.joinRoom(user, code, c.req.valid("json"));
    return c.json(successResponse("Joined room successfully", room));
  },
);

roomsRoutes.post("/:id/leave", requireAuth, async (c) => {
  const user = c.get("user")!;
  const roomId = c.req.param("id");
  const room = await RoomsService.leaveRoom(user, roomId);
  return c.json(successResponse("Left room successfully", room));
});

roomsRoutes.patch(
  "/:id/settings",
  requireAuth,
  validateBody(updateRoomSettingsSchema),
  async (c) => {
    const user = c.get("user")!;
    const roomId = c.req.param("id");
    const room = await RoomsService.updateSettings(
      user,
      roomId,
      c.req.valid("json"),
    );
    return c.json(successResponse("Room settings updated", room));
  },
);

roomsRoutes.post("/:id/start", requireAuth, async (c) => {
  const user = c.get("user")!;
  const roomId = c.req.param("id");
  const body = (await c.req.json().catch(() => ({}))) as { force?: boolean };
  const result = await RoomsService.startGame(user, roomId, {
    force: Boolean(body?.force),
  });
  return c.json(successResponse("Game started successfully", result));
});

roomsRoutes.post("/:id/rematch", requireAuth, async (c) => {
  const user = c.get("user")!;
  const roomId = c.req.param("id");
  const result = await RoomsService.rematch(user, roomId);
  return c.json(successResponse("Rematch started successfully", result));
});

roomsRoutes.post("/:id/lobby", requireAuth, async (c) => {
  const user = c.get("user")!;
  const roomId = c.req.param("id");
  const result = await RoomsService.returnToLobby(user, roomId);
  return c.json(successResponse("Returned to lobby", result));
});
