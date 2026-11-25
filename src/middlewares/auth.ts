import { getCookie } from "hono/cookie";
import { createMiddleware } from "hono/factory";
import { eq } from "drizzle-orm";
import { db, sessions, type User } from "../database";
import { UnauthorizedError } from "../errors";

export type AuthVariables = {
  user: User;
};

export async function resolveSessionUser(
  sessionId: string | undefined,
): Promise<User | null> {
  if (!sessionId) return null;

  const session = await db.query.sessions.findFirst({
    where: eq(sessions.id, sessionId),
    with: { user: true },
  });

  if (!session || !session.user || session.expiresAt < new Date()) {
    return null;
  }

  return session.user;
}

export const requireAuth = createMiddleware<{ Variables: AuthVariables }>(
  async (c, next) => {
    const sessionId = getCookie(c, "session_id");
    const user = await resolveSessionUser(sessionId);

    if (!user) {
      throw new UnauthorizedError("Unauthorized: Valid session required");
    }

    c.set("user", user);
    await next();
  },
);

export const optionalAuth = createMiddleware<{
  Variables: Partial<AuthVariables>;
}>(async (c, next) => {
  const sessionId = getCookie(c, "session_id");
  const user = await resolveSessionUser(sessionId);
  if (user) {
    c.set("user", user);
  }
  await next();
});
