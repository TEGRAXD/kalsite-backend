import { basename, join } from "node:path";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { getCookie } from "hono/cookie";
import { env } from "./config";
import { AppError } from "./errors";
import { apiGuard, resolveSessionUser } from "./middlewares/auth";
import { adminModule } from "./modules/admin";
import { authModule } from "./modules/auth";
import { sanitizeUser } from "./modules/auth/auth.route";
import { operatorsModule } from "./modules/operators";
import {
  FACTION_UPLOADS_DIR,
  OPERATOR_UPLOADS_DIR,
} from "./modules/operators/operators.sync";
import { roomsModule } from "./modules/rooms";
import { usersModule } from "./modules/users";
import { errorResponse, successResponse } from "./utils/response";

export const app = new Hono();

app.use(
  "*",
  cors({
    origin: env.WEB_URL,
    credentials: true,
    allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization", "x-api-key"],
  }),
);

app.use("*", apiGuard);

app.get("/", (c) =>
  c.json(
    successResponse("Kalsite API is running", {
      name: "Kalsite API",
      version: "1.0.0",
      status: "ok",
    }),
  ),
);

app.get("/health", (c) =>
  c.json(successResponse("Healthy", { uptime: process.uptime() })),
);

// Convenience alias matching proposal spec (`GET /me`)
app.get("/me", async (c) => {
  const sessionId = getCookie(c, "session_id");
  const user = await resolveSessionUser(sessionId);
  if (!user) {
    return c.json(errorResponse("Not authenticated"), 401);
  }
  return c.json(
    successResponse("Current user retrieved", { user: sanitizeUser(user) }),
  );
});

// Serve locally downloaded / uploaded operator avatars from our own server
app.get("/uploads/operators/:filename", async (c) => {
  const rawFilename = c.req.param("filename");
  const safeName = basename(rawFilename);
  if (!safeName || safeName !== rawFilename) {
    return c.json(errorResponse("Invalid file path"), 400);
  }

  const file = Bun.file(join(OPERATOR_UPLOADS_DIR, safeName));
  if (!(await file.exists())) {
    return c.json(errorResponse("Asset not found"), 404);
  }

  return new Response(file, {
    headers: {
      "Content-Type": file.type || "image/png",
      "Cache-Control": "public, max-age=86400",
    },
  });
});

// Serve locally downloaded faction emblem logos
app.get("/uploads/factions/:filename", async (c) => {
  const rawFilename = c.req.param("filename");
  const safeName = basename(rawFilename);
  if (!safeName || safeName !== rawFilename) {
    return c.json(errorResponse("Invalid file path"), 400);
  }

  const file = Bun.file(join(FACTION_UPLOADS_DIR, safeName));
  if (!(await file.exists())) {
    return c.json(errorResponse("Asset not found"), 404);
  }

  return new Response(file, {
    headers: {
      "Content-Type": file.type || "image/png",
      "Cache-Control": "public, max-age=86400",
    },
  });
});

app.route("/auth", authModule);
app.route("/operators", operatorsModule);
app.route("/rooms", roomsModule);
app.route("/users", usersModule);
app.route("/admin", adminModule);

app.notFound((c) => c.json(errorResponse("Endpoint not found"), 404));

app.onError((error, c) => {
  if (error instanceof AppError) {
    return c.json(errorResponse(error.message), error.statusCode as any);
  }

  console.error("Unexpected Error:", error);
  return c.json(errorResponse("Internal server error"), 500);
});
