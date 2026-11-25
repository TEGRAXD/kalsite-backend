import { Hono } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { env, isDiscordConfigured } from "../../config";
import { db, users, sessions } from "../../database";
import { resolveSessionUser } from "../../middlewares/auth";
import { validateBody } from "../../middlewares/validator";
import { BadRequestError, ForbiddenError } from "../../errors";
import { errorResponse, successResponse } from "../../utils/response";

export const authRoutes = new Hono();

const SESSION_MAX_AGE = 60 * 60 * 24 * 30; // 30 days
const OAUTH_STATE_MAX_AGE = 60 * 10; // 10 minutes

function getCookieDomain(webUrl: string): string | undefined {
  try {
    const hostname = new URL(webUrl).hostname;
    if (hostname === "localhost" || /^(\d{1,3}\.){3}\d{1,3}$/.test(hostname)) {
      return undefined;
    }
    const parts = hostname.split(".");
    if (parts.length >= 2) {
      return "." + parts.slice(-2).join(".");
    }
    return "." + hostname;
  } catch {
    return undefined;
  }
}

export function sanitizeUser(user: typeof users.$inferSelect) {
  return {
    id: user.id,
    discordId: user.discordId,
    username: user.username,
    globalName: user.globalName,
    avatar: user.avatar,
    createdAt: user.createdAt,
  };
}

async function createSessionForUser(userId: string) {
  const sessionId = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + SESSION_MAX_AGE * 1000);
  await db.insert(sessions).values({
    id: sessionId,
    userId,
    expiresAt,
  });
  return { sessionId, expiresAt };
}

authRoutes.get("/providers", (c) => {
  return c.json(
    successResponse("Auth providers retrieved", {
      discord: isDiscordConfigured,
      devLogin: env.ALLOW_DEV_LOGIN && env.NODE_ENV !== "production",
    }),
  );
});

function getSafeNextPath(raw: string | undefined): string {
  if (!raw || !raw.startsWith("/") || raw.startsWith("//")) {
    return "/guess-who-am-i";
  }
  return raw;
}

authRoutes.get("/discord", (c) => {
  if (!isDiscordConfigured) {
    return c.redirect(`${env.WEB_URL}/login?error=discord_not_configured`);
  }

  const state = crypto.randomUUID();
  const nextPath = getSafeNextPath(c.req.query("next"));
  const cookieDomain = getCookieDomain(env.WEB_URL);

  setCookie(c, "oauth_state", state, {
    path: "/",
    domain: cookieDomain,
    httpOnly: true,
    secure: env.NODE_ENV === "production",
    sameSite: "Lax",
    maxAge: OAUTH_STATE_MAX_AGE,
  });

  setCookie(c, "oauth_next", nextPath, {
    path: "/",
    domain: cookieDomain,
    httpOnly: true,
    secure: env.NODE_ENV === "production",
    sameSite: "Lax",
    maxAge: OAUTH_STATE_MAX_AGE,
  });

  const url = new URL("https://discord.com/api/oauth2/authorize");
  url.searchParams.set("client_id", env.DISCORD_CLIENT_ID);
  url.searchParams.set("redirect_uri", env.DISCORD_REDIRECT_URI);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", "identify");
  url.searchParams.set("state", state);

  return c.redirect(url.toString());
});

authRoutes.get("/discord/callback", async (c) => {
  const error = c.req.query("error");
  if (error) {
    return c.redirect(`${env.WEB_URL}/login?error=${encodeURIComponent(error)}`);
  }

  const code = c.req.query("code");
  const returnedState = c.req.query("state");
  const storedState = getCookie(c, "oauth_state");

  deleteCookie(c, "oauth_state", { path: "/" });

  if (!code) {
    throw new BadRequestError("Missing OAuth authorization code");
  }

  if (!returnedState || !storedState || returnedState !== storedState) {
    return c.redirect(`${env.WEB_URL}/login?error=invalid_oauth_state`);
  }

  const tokenResponse = await fetch("https://discord.com/api/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.DISCORD_CLIENT_ID,
      client_secret: env.DISCORD_CLIENT_SECRET,
      grant_type: "authorization_code",
      code,
      redirect_uri: env.DISCORD_REDIRECT_URI,
    }).toString(),
  });

  const tokenData = (await tokenResponse.json()) as {
    access_token?: string;
    error?: string;
    error_description?: string;
  };

  if (!tokenResponse.ok || !tokenData.access_token) {
    console.error("Discord token exchange failed:", tokenData);
    return c.redirect(`${env.WEB_URL}/login?error=token_exchange_failed`);
  }

  const userResponse = await fetch("https://discord.com/api/users/@me", {
    headers: { Authorization: `Bearer ${tokenData.access_token}` },
  });

  if (!userResponse.ok) {
    return c.redirect(`${env.WEB_URL}/login?error=discord_profile_failed`);
  }

  const discordUser = (await userResponse.json()) as {
    id: string;
    username: string;
    global_name?: string | null;
    avatar?: string | null;
  };

  const avatarUrl = discordUser.avatar
    ? `https://cdn.discordapp.com/avatars/${discordUser.id}/${discordUser.avatar}.png`
    : null;

  const existing = await db.query.users.findFirst({
    where: eq(users.discordId, discordUser.id),
  });

  let userId: string;
  if (existing) {
    userId = existing.id;
    await db
      .update(users)
      .set({
        username: discordUser.username,
        globalName: discordUser.global_name ?? discordUser.username,
        avatar: avatarUrl,
      })
      .where(eq(users.id, userId));
  } else {
    userId = crypto.randomUUID();
    await db.insert(users).values({
      id: userId,
      discordId: discordUser.id,
      username: discordUser.username,
      globalName: discordUser.global_name ?? discordUser.username,
      avatar: avatarUrl,
    });
  }

  const { sessionId } = await createSessionForUser(userId);
  const cookieDomain = getCookieDomain(env.WEB_URL);

  setCookie(c, "session_id", sessionId, {
    path: "/",
    domain: cookieDomain,
    secure: env.NODE_ENV === "production",
    httpOnly: true,
    maxAge: SESSION_MAX_AGE,
    sameSite: "Lax",
  });

  const nextPath = getSafeNextPath(getCookie(c, "oauth_next"));
  deleteCookie(c, "oauth_next", { path: "/", domain: cookieDomain });

  return c.redirect(`${env.WEB_URL}${nextPath}`);
});

const devLoginSchema = z.object({
  username: z
    .string()
    .trim()
    .min(2, "Name must be at least 2 characters")
    .max(24, "Name must be at most 24 characters")
    .regex(
      /^[a-zA-Z0-9_\-. ']+$/,
      "Only letters, numbers, spaces, _, -, ., ' allowed",
    ),
});

authRoutes.post("/dev-login", validateBody(devLoginSchema), async (c) => {
  if (!env.ALLOW_DEV_LOGIN || env.NODE_ENV === "production") {
    throw new ForbiddenError("Development login is disabled");
  }

  const { username } = c.req.valid("json");
  const normalized = username
    .toLowerCase()
    .replace(/'/g, "")
    .replace(/\s+/g, "_");
  if (normalized.length < 2) {
    throw new BadRequestError(
      "Name must include at least 2 alphanumeric or identifier characters",
    );
  }
  const devDiscordId = `dev:${normalized}`;

  let user = await db.query.users.findFirst({
    where: eq(users.discordId, devDiscordId),
  });

  if (!user) {
    const id = crypto.randomUUID();
    await db.insert(users).values({
      id,
      discordId: devDiscordId,
      username: normalized,
      globalName: username,
      avatar: null,
    });
    user = await db.query.users.findFirst({ where: eq(users.id, id) });
  } else if (user.globalName !== username) {
    await db
      .update(users)
      .set({ globalName: username })
      .where(eq(users.id, user.id));
    user = { ...user, globalName: username };
  }

  if (!user) {
    return c.json(errorResponse("Failed to create user"), 500);
  }

  const { sessionId } = await createSessionForUser(user.id);
  const cookieDomain = getCookieDomain(env.WEB_URL);

  setCookie(c, "session_id", sessionId, {
    path: "/",
    domain: cookieDomain,
    secure: false,
    httpOnly: true,
    maxAge: SESSION_MAX_AGE,
    sameSite: "Lax",
  });

  return c.json(
    successResponse("Signed in successfully", { user: sanitizeUser(user) }),
  );
});

authRoutes.get("/me", async (c) => {
  const sessionId = getCookie(c, "session_id");
  const user = await resolveSessionUser(sessionId);

  if (!user) {
    return c.json(errorResponse("Not authenticated"), 401);
  }

  return c.json(
    successResponse("Current user retrieved", { user: sanitizeUser(user) }),
  );
});

authRoutes.post("/logout", async (c) => {
  const sessionId = getCookie(c, "session_id");
  if (sessionId) {
    await db.delete(sessions).where(eq(sessions.id, sessionId));
  }
  const cookieDomain = getCookieDomain(env.WEB_URL);
  setCookie(c, "session_id", "", {
    path: "/",
    domain: cookieDomain,
    maxAge: 0,
    httpOnly: true,
    secure: env.NODE_ENV === "production",
    sameSite: "Lax",
  });

  return c.json(successResponse("Logged out successfully", null));
});
