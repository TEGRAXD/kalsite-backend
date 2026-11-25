import { zValidator } from "@hono/zod-validator";
import { validator } from "hono/validator";
import type { ZodType } from "zod";
import { errorResponse } from "../utils/response";

export const validateJson = <T extends ZodType<any, any, any>>(schema: T) => {
  return zValidator("json", schema, (result, c) => {
    if (!result.success) {
      return c.json(
        errorResponse(
          "Validation failed",
          result.error.issues.map((issue) => ({
            field: issue.path.join("."),
            message: issue.message,
          })),
        ),
        400,
      );
    }
  });
};

export const validateBody = <T extends ZodType<any, any, any>>(schema: T) => {
  return validator("json", async (_value, c) => {
    const contentType = c.req.header("Content-Type") || "";
    let parsedBody: unknown;

    try {
      if (
        contentType.includes("application/x-www-form-urlencoded") ||
        contentType.includes("multipart/form-data")
      ) {
        parsedBody = await c.req.parseBody();
      } else {
        parsedBody = await c.req.json();
      }
    } catch {
      parsedBody = {};
    }

    const result = schema.safeParse(parsedBody);

    if (!result.success) {
      return c.json(
        errorResponse(
          "Validation failed",
          result.error.issues.map((issue) => ({
            field: issue.path.join("."),
            message: issue.message,
          })),
        ),
        400,
      );
    }

    return result.data;
  });
};
