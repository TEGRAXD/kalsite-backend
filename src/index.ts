import { app } from "./app";
import { env } from "./config";
import { resolveSessionUser } from "./middlewares/auth";
import { roomCleanup } from "./modules/rooms/rooms.cleanup";
import { parseCookieHeader, websocketHandler } from "./websocket";
import type { WsSocketData } from "./websocket/hub";

const server = Bun.serve<WsSocketData>({
  hostname: env.API_HOST,
  port: env.API_PORT,

  async fetch(req, bunServer) {
    const url = new URL(req.url);

    if (url.pathname === "/ws") {
      const cookies = parseCookieHeader(req.headers.get("cookie"));
      const user = await resolveSessionUser(cookies.session_id);

      if (!user) {
        return new Response(
          JSON.stringify({ success: false, message: "Unauthorized WebSocket" }),
          { status: 401, headers: { "Content-Type": "application/json" } },
        );
      }

      const upgraded = bunServer.upgrade(req, {
        data: {
          userId: user.id,
          username: user.username,
          globalName: user.globalName,
          avatar: user.avatar,
          roleId: user.roleId,
          roomId: null,
          roomCode: null,
        },
      });

      if (upgraded) {
        return undefined;
      }

      return new Response("WebSocket upgrade failed", { status: 400 });
    }

    return app.fetch(req);
  },

  websocket: websocketHandler,
});

roomCleanup.start();

console.log(
  `[KALSITE] API + WebSocket running at http://${server.hostname}:${server.port}`,
);
