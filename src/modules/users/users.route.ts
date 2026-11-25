import { Hono } from "hono";
import { asc, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { db, ROLE_IDS, roles, users } from "../../database";
import { BadRequestError, NotFoundError } from "../../errors";
import {
  requireAuth,
  requireSuperAdmin,
  type AuthVariables,
} from "../../middlewares/auth";
import { validateBody } from "../../middlewares/validator";
import { successResponse } from "../../utils/response";

export const usersRoutes = new Hono<{ Variables: Partial<AuthVariables> }>();

usersRoutes.use("*", requireAuth, requireSuperAdmin);

const updateRoleSchema = z.object({
  roleId: z.string().trim().min(1, "Role ID is required"),
});

// GET /users - list all users and available roles
usersRoutes.get("/", async (c) => {
  const [allUsers, allRoles] = await Promise.all([
    db.query.users.findMany({
      orderBy: [desc(users.createdAt)],
      columns: {
        id: true,
        discordId: true,
        username: true,
        globalName: true,
        avatar: true,
        roleId: true,
        createdAt: true,
        updatedAt: true,
      },
      with: {
        role: {
          columns: {
            id: true,
            name: true,
            description: true,
          },
        },
      },
    }),
    db.query.roles.findMany({
      orderBy: [asc(roles.id)],
      columns: {
        id: true,
        name: true,
        description: true,
      },
    }),
  ]);

  return c.json(
    successResponse("Users retrieved successfully", {
      users: allUsers,
      roles: allRoles,
    }),
  );
});

// PATCH /users/:id/role - update a user's role
usersRoutes.patch(
  "/:id/role",
  validateBody(updateRoleSchema),
  async (c) => {
    const actor = c.get("user")!;
    const targetUserId = c.req.param("id").trim();
    const { roleId } = c.req.valid("json");

    const role = await db.query.roles.findFirst({
      where: eq(roles.id, roleId),
      columns: { id: true, name: true, description: true },
    });

    if (!role) {
      throw new NotFoundError(`Role "${roleId}" not found`);
    }

    const targetUser = await db.query.users.findFirst({
      where: eq(users.id, targetUserId),
    });

    if (!targetUser) {
      throw new NotFoundError("User not found");
    }

    if (
      targetUser.id === actor.id &&
      roleId !== ROLE_IDS.SUPER_ADMIN
    ) {
      throw new BadRequestError(
        "You cannot remove your own Super Administrator role",
      );
    }

    const [updatedUser] = await db
      .update(users)
      .set({ roleId, updatedAt: new Date() })
      .where(eq(users.id, targetUserId))
      .returning({
        id: users.id,
        discordId: users.discordId,
        username: users.username,
        globalName: users.globalName,
        avatar: users.avatar,
        roleId: users.roleId,
        createdAt: users.createdAt,
        updatedAt: users.updatedAt,
      });

    return c.json(
      successResponse("User role updated successfully", {
        ...updatedUser,
        role,
      }),
    );
  },
);
