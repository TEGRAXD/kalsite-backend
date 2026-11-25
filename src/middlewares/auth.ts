import { timingSafeEqual } from "node:crypto";
import { getCookie } from "hono/cookie";
import { createMiddleware } from "hono/factory";
import { eq } from "drizzle-orm";
import { env } from "../config";
import { db, ROLE_IDS, sessions, type User } from "../database";
import { ForbiddenError, UnauthorizedError } from "../errors";

export type AuthVariables = {
  user: User;
  isApiKeyAuth?: boolean;
};

function matchesApiSecret(candidate: string | undefined | null): boolean {
  if (!candidate) return false;
  const expected = env.API_SECRET_KEY;
  const a = Buffer.from(candidate);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

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

/**
 * Global API guard:
 * - Allows CORS preflight, health/status, static /uploads assets, and /auth/* routes.
 * - Requires either a valid server-side API key (`x-api-key` or `Authorization: Bearer`)
 *   OR a valid logged-in `session_id` HttpOnly cookie on all other routes.
 */
export const apiGuard = createMiddleware<{ Variables: Partial<AuthVariables> }>(
  async (c, next) => {
    if (c.req.method === "OPTIONS") {
      return next();
    }

    const path = c.req.path;
    if (
      path === "/" ||
      path === "/health" ||
      path.startsWith("/uploads/") ||
      path.startsWith("/auth/")
    ) {
      return next();
    }

    const apiKeyHeader = c.req.header("x-api-key");
    const authHeader = c.req.header("authorization");
    const bearerToken = authHeader?.startsWith("Bearer ")
      ? authHeader.slice(7).trim()
      : null;

    if (matchesApiSecret(apiKeyHeader) || matchesApiSecret(bearerToken)) {
      c.set("isApiKeyAuth", true);
      return next();
    }

    const sessionId = getCookie(c, "session_id");
    const user = await resolveSessionUser(sessionId);
    if (user) {
      c.set("user", user);
      return next();
    }

    throw new UnauthorizedError(
      "Unauthorized: Valid session or API key required",
    );
  },
);

export const requireAuth = createMiddleware<{
  Variables: Partial<AuthVariables>;
}>(async (c, next) => {
  const existing = c.get("user");
  if (existing) {
    return next();
  }

  const sessionId = getCookie(c, "session_id");
  const user = await resolveSessionUser(sessionId);

  if (!user) {
    throw new UnauthorizedError("Unauthorized: Valid session required");
  }

  c.set("user", user);
  await next();
});

export const optionalAuth = createMiddleware<{
  Variables: Partial<AuthVariables>;
}>(async (c, next) => {
  if (!c.get("user")) {
    const sessionId = getCookie(c, "session_id");
    const user = await resolveSessionUser(sessionId);
    if (user) {
      c.set("user", user);
    }
  }
  await next();
});

export const requireAdmin = createMiddleware<{
  Variables: Partial<AuthVariables>;
}>(async (c, next) => {
  const user = c.get("user");
  if (
    !user ||
    (user.roleId !== ROLE_IDS.ADMIN && user.roleId !== ROLE_IDS.SUPER_ADMIN)
  ) {
    throw new ForbiddenError("Forbidden: Administrator access required");
  }
  await next();
});

export const requireSuperAdmin = createMiddleware<{
  Variables: Partial<AuthVariables>;
}>(async (c, next) => {
  const user = c.get("user");
  if (!user || user.roleId !== ROLE_IDS.SUPER_ADMIN) {
    throw new ForbiddenError("Forbidden: Super Administrator access required");
  }
  await next();
});
