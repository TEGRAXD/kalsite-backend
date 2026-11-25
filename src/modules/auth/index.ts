import { Hono } from "hono";
import { authRoutes } from "./auth.route";

export const authModule = new Hono();
authModule.route("/", authRoutes);
