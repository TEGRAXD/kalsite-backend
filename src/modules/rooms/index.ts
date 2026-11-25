import { Hono } from "hono";
import { roomsRoutes } from "./rooms.route";

export const roomsModule = new Hono();
roomsModule.route("/", roomsRoutes);
