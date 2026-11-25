import { createHmac, timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { env, isDiscordConfigured, SUPER_ADMIN_IDS } from "../../config";
import { db, ROLE_IDS, users, sessions } from "../../database";
import { resolveSessionUser } from "../../middlewares/auth";
import { validateBody } from "../../middlewares/validator";
import { BadRequestError, ForbiddenError } from "../../errors";
import { errorResponse, successResponse } from "../../utils/response";

export const authRoutes = new Hono();

const SESSION_MAX_AGE = 60 * 60 * 24 * 30; // 30 days
const OAUTH_STATE_TTL_MS = 10 * 60 * 1000; // 10 minutes

function isSecureCookie(): boolean {
  return env.NODE_ENV === "production" || env.WEB_URL.startsWith("https://");
}

function getCookieDomain(): string | undefined {
  if (env.COOKIE_DOMAIN) {
    return env.COOKIE_DOMAIN;
  }

  try {
    const webHost = new URL(env.WEB_URL).hostname;
    if (webHost === "localhost" || /^(\d{1,3}\.){3}\d{1,3}$/.test(webHost)) {
      return undefined;
    }

    // If API redirect URI shares the exact same host as WEB_URL, use a host-only cookie
    try {
      const apiHost = new URL(env.DISCORD_REDIRECT_URI).hostname;
      if (apiHost === webHost) {
        return undefined;
      }

      // Compute the longest shared parent domain between WEB and API (at least 2 labels)
      const webParts = webHost.split(".").reverse();
      const apiParts = apiHost.split(".").reverse();
      const shared: string[] = [];
      for (let i = 0; i < Math.min(webParts.length, apiParts.length); i++) {
        if (webParts[i] === apiParts[i]) {
          shared.push(webParts[i]!);
        } else {
          break;
        }
      }
      if (shared.length >= 2) {
        return "." + shared.reverse().join(".");
      }
    } catch {
      // Fallback below
    }

    const parts = webHost.split(".");
    if (parts.length >= 2) {
      return "." + parts.slice(-2).join(".");
    }
    return "." + webHost;
  } catch {
    return undefined;
  }
}

function getSafeNextPath(raw: string | undefined | null): string {
  if (!raw || !raw.startsWith("/") || raw.startsWith("//")) {
    return "/guess-who-am-i";
  }
  return raw;
}

function signOAuthState(nextPath: string): string {
  const payload = Buffer.from(
    JSON.stringify({
      next: getSafeNextPath(nextPath),
      exp: Date.now() + OAUTH_STATE_TTL_MS,
      nonce: crypto.randomUUID(),
    }),
  ).toString("base64url");

  const sig = createHmac("sha256", env.SESSION_SECRET)
    .update(payload)
    .digest("base64url");

  return `${payload}.${sig}`;
}

function verifyOAuthState(
  rawState: string | undefined,
): { valid: boolean; nextPath: string } {
  if (!rawState) return { valid: false, nextPath: "/guess-who-am-i" };

  const dotIdx = rawState.indexOf(".");
  if (dotIdx <= 0) return { valid: false, nextPath: "/guess-who-am-i" };

  const payload = rawState.slice(0, dotIdx);
  const sig = rawState.slice(dotIdx + 1);
  const expectedSig = createHmac("sha256", env.SESSION_SECRET)
    .update(payload)
    .digest("base64url");

  const a = Buffer.from(sig);
  const b = Buffer.from(expectedSig);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { valid: false, nextPath: "/guess-who-am-i" };
  }

  try {
    const parsed = JSON.parse(
      Buffer.from(payload, "base64url").toString("utf8"),
    ) as { next?: string; exp?: number };

    if (!parsed.exp || Date.now() > parsed.exp) {
      return { valid: false, nextPath: getSafeNextPath(parsed.next) };
    }

    return { valid: true, nextPath: getSafeNextPath(parsed.next) };
  } catch {
    return { valid: false, nextPath: "/guess-who-am-i" };
  }
}

export function sanitizeUser(user: typeof users.$inferSelect) {
  return {
    id: user.id,
    discordId: user.discordId,
    username: user.username,
    globalName: user.globalName,
    avatar: user.avatar,
    roleId: user.roleId,
    createdAt: user.createdAt,
  };
}

async function resolveInitialRoleId(discordId: string): Promise<string> {
  if (SUPER_ADMIN_IDS.has(discordId)) {
    return ROLE_IDS.SUPER_ADMIN;
  }

  // In non-production dev mode, promote the very first user if no super-admin exists yet
  if (env.NODE_ENV !== "production" && env.ALLOW_DEV_LOGIN) {
    const existingSuperAdmin = await db.query.users.findFirst({
      where: eq(users.roleId, ROLE_IDS.SUPER_ADMIN),
      columns: { id: true },
    });
    if (!existingSuperAdmin) {
      return ROLE_IDS.SUPER_ADMIN;
    }
  }

  return ROLE_IDS.USER;
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

authRoutes.get("/discord", (c) => {
  if (!isDiscordConfigured) {
    return c.redirect(`${env.WEB_URL}/login?error=discord_not_configured`);
  }

  const nextPath = getSafeNextPath(c.req.query("next"));
  const state = signOAuthState(nextPath);
  const promptParam = c.req.query("prompt");
  const prompt = promptParam === "consent" ? "consent" : "none";

  const url = new URL("https://discord.com/api/oauth2/authorize");
  url.searchParams.set("client_id", env.DISCORD_CLIENT_ID);
  url.searchParams.set("redirect_uri", env.DISCORD_REDIRECT_URI);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", "identify");
  url.searchParams.set("prompt", prompt);
  url.searchParams.set("state", state);

  return c.redirect(url.toString());
});

authRoutes.get("/discord/callback", async (c) => {
  if (!isDiscordConfigured) {
    return c.redirect(`${env.WEB_URL}/login?error=discord_not_configured`);
  }

  const returnedState = c.req.query("state");
  const stateCheck = verifyOAuthState(returnedState);
  const nextPath = stateCheck.nextPath;

  const error = c.req.query("error");
  if (error) {
    // Seamless re-login fallback (like Mozha): if prompt=none requires user consent, retry with prompt=consent
    if (error === "consent_required" || error === "interaction_required") {
      return c.redirect(
        `/auth/discord?prompt=consent&next=${encodeURIComponent(nextPath)}`,
      );
    }

    return c.redirect(
      `${env.WEB_URL}/login?error=${encodeURIComponent(error)}&next=${encodeURIComponent(nextPath)}`,
    );
  }

  const code = c.req.query("code");
  if (!code) {
    return c.redirect(
      `${env.WEB_URL}/login?error=missing_code&next=${encodeURIComponent(nextPath)}`,
    );
  }

  if (!stateCheck.valid) {
    return c.redirect(
      `${env.WEB_URL}/login?error=invalid_oauth_state&next=${encodeURIComponent(nextPath)}`,
    );
  }

  let tokenData: {
    access_token?: string;
    error?: string;
    error_description?: string;
  };
  try {
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

    tokenData = (await tokenResponse.json()) as typeof tokenData;
    if (!tokenResponse.ok || !tokenData.access_token) {
      console.error("[auth:discord] Token exchange failed:", tokenData);
      return c.redirect(
        `${env.WEB_URL}/login?error=token_exchange_failed&next=${encodeURIComponent(nextPath)}`,
      );
    }
  } catch (err) {
    console.error("[auth:discord] Token exchange network error:", err);
    return c.redirect(
      `${env.WEB_URL}/login?error=oauth_network_error&next=${encodeURIComponent(nextPath)}`,
    );
  }

  let discordUser: {
    id: string;
    username: string;
    global_name?: string | null;
    avatar?: string | null;
  };
  try {
    const userResponse = await fetch("https://discord.com/api/users/@me", {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
    });

    if (!userResponse.ok) {
      console.error(
        "[auth:discord] Profile fetch failed:",
        userResponse.status,
      );
      return c.redirect(
        `${env.WEB_URL}/login?error=discord_profile_failed&next=${encodeURIComponent(nextPath)}`,
      );
    }

    discordUser = (await userResponse.json()) as typeof discordUser;
  } catch (err) {
    console.error("[auth:discord] Profile fetch network error:", err);
    return c.redirect(
      `${env.WEB_URL}/login?error=oauth_network_error&next=${encodeURIComponent(nextPath)}`,
    );
  }

  const avatarExt = discordUser.avatar?.startsWith("a_") ? "gif" : "png";
  const avatarUrl = discordUser.avatar
    ? `https://cdn.discordapp.com/avatars/${discordUser.id}/${discordUser.avatar}.${avatarExt}`
    : null;

  const existing = await db.query.users.findFirst({
    where: eq(users.discordId, discordUser.id),
  });

  let userId: string;
  if (existing) {
    userId = existing.id;
    const nextRoleId = SUPER_ADMIN_IDS.has(discordUser.id)
      ? ROLE_IDS.SUPER_ADMIN
      : existing.roleId;
    await db
      .update(users)
      .set({
        username: discordUser.username,
        globalName: discordUser.global_name ?? discordUser.username,
        avatar: avatarUrl,
        roleId: nextRoleId,
        updatedAt: new Date(),
      })
      .where(eq(users.id, userId));
  } else {
    userId = crypto.randomUUID();
    const roleId = await resolveInitialRoleId(discordUser.id);
    await db.insert(users).values({
      id: userId,
      discordId: discordUser.id,
      username: discordUser.username,
      globalName: discordUser.global_name ?? discordUser.username,
      avatar: avatarUrl,
      roleId,
    });
  }

  const { sessionId } = await createSessionForUser(userId);
  const cookieDomain = getCookieDomain();

  setCookie(c, "session_id", sessionId, {
    path: "/",
    domain: cookieDomain,
    secure: isSecureCookie(),
    httpOnly: true,
    maxAge: SESSION_MAX_AGE,
    sameSite: "Lax",
  });

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
    const roleId = await resolveInitialRoleId(devDiscordId);
    await db.insert(users).values({
      id,
      discordId: devDiscordId,
      username: normalized,
      globalName: username,
      avatar: null,
      roleId,
    });
    user = await db.query.users.findFirst({ where: eq(users.id, id) });
  } else {
    const shouldPromote =
      SUPER_ADMIN_IDS.has(devDiscordId) && user.roleId !== ROLE_IDS.SUPER_ADMIN;
    if (user.globalName !== username || shouldPromote) {
      const nextRoleId = shouldPromote ? ROLE_IDS.SUPER_ADMIN : user.roleId;
      await db
        .update(users)
        .set({
          globalName: username,
          roleId: nextRoleId,
          updatedAt: new Date(),
        })
        .where(eq(users.id, user.id));
      user = { ...user, globalName: username, roleId: nextRoleId };
    }
  }

  if (!user) {
    return c.json(errorResponse("Failed to create user"), 500);
  }

  const { sessionId } = await createSessionForUser(user.id);
  const cookieDomain = getCookieDomain();

  setCookie(c, "session_id", sessionId, {
    path: "/",
    domain: cookieDomain,
    secure: isSecureCookie(),
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
  const cookieDomain = getCookieDomain();
  setCookie(c, "session_id", "", {
    path: "/",
    domain: cookieDomain,
    maxAge: 0,
    httpOnly: true,
    secure: isSecureCookie(),
    sameSite: "Lax",
  });

  return c.json(successResponse("Logged out successfully", null));
});
