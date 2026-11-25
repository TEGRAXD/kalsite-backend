import { Hono } from "hono";
import { operatorsRoutes } from "./operators.route";

export const operatorsModule = new Hono();
operatorsModule.route("/", operatorsRoutes);
