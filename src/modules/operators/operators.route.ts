import { Hono } from "hono";
import { ROLE_IDS } from "../../database";
import { BadRequestError } from "../../errors";
import {
  requireAdmin,
  requireAuth,
  type AuthVariables,
} from "../../middlewares/auth";
import { successResponse } from "../../utils/response";
import {
  createOperatorSchema,
  syncOperatorsSchema,
  updateOperatorSchema,
} from "./operators.schema";
import { OperatorsService } from "./operators.service";

export const operatorsRoutes = new Hono<{ Variables: Partial<AuthVariables> }>();

function canViewDisabled(c: {
  get: <K extends keyof AuthVariables>(key: K) => AuthVariables[K] | undefined;
}): boolean {
  if (c.get("isApiKeyAuth")) return true;
  const user = c.get("user");
  return Boolean(
    user &&
      (user.roleId === ROLE_IDS.ADMIN ||
        user.roleId === ROLE_IDS.SUPER_ADMIN),
  );
}

async function parseOperatorPayload(c: {
  req: {
    header: (name: string) => string | undefined;
    parseBody: () => Promise<Record<string, unknown>>;
    json: <T>() => Promise<T>;
  };
}): Promise<{ body: Record<string, unknown>; imageFile: File | null }> {
  const contentType = c.req.header("content-type") || "";
  if (contentType.includes("multipart/form-data")) {
    const form = await c.req.parseBody();
    const rawFile = form.image;
    const imageFile = rawFile instanceof File ? rawFile : null;
    const { image: _ignored, ...rest } = form;
    return { body: rest, imageFile };
  }

  const json = await c.req.json<Record<string, unknown>>().catch(() => ({}));
  return { body: json, imageFile: null };
}

operatorsRoutes.get("/", async (c) => {
  const search = c.req.query("search")?.trim() || undefined;
  const operatorClass = c.req.query("class")?.trim() || undefined;
  const rarityParam = c.req.query("rarity");
  const limitParam = c.req.query("limit");

  const rarity = rarityParam ? Number.parseInt(rarityParam, 10) : undefined;
  const limit = limitParam ? Number.parseInt(limitParam, 10) : undefined;
  const wantsDisabled = c.req.query("includeDisabled") === "true";
  const includeDisabled = wantsDisabled && canViewDisabled(c);

  const list = await OperatorsService.list({
    search,
    operatorClass,
    rarity: Number.isNaN(rarity) ? undefined : rarity,
    limit: Number.isNaN(limit) ? undefined : limit,
    includeDisabled,
  });

  return c.json(successResponse("Operators retrieved successfully", list));
});

// Pull latest character_table.json + download missing avatars from fexli/ArknightsResource
operatorsRoutes.post("/sync", requireAuth, requireAdmin, async (c) => {
  const rawBody = await c.req.json().catch(() => ({}));
  const parsed = syncOperatorsSchema.safeParse(rawBody);
  if (!parsed.success) {
    throw new BadRequestError("Invalid sync options");
  }

  const summary = await OperatorsService.syncFromGitHub({
    forceRedownloadImages: parsed.data?.forceRedownloadImages ?? false,
  });

  return c.json(
    successResponse(
      `Synced ${summary.totalFetched} operators from ArknightsResource`,
      summary,
    ),
  );
});

// Manually add an Operator (supports JSON or multipart/form-data with `image` file)
operatorsRoutes.post("/", requireAuth, requireAdmin, async (c) => {
  const { body, imageFile } = await parseOperatorPayload(c);
  const parsed = createOperatorSchema.safeParse(body);
  if (!parsed.success) {
    throw new BadRequestError(
      parsed.error.issues[0]?.message || "Invalid operator payload",
    );
  }

  const created = await OperatorsService.createManual(parsed.data, imageFile);
  return c.json(successResponse("Operator created successfully", created), 201);
});

operatorsRoutes.patch("/:id", requireAuth, requireAdmin, async (c) => {
  const { body, imageFile } = await parseOperatorPayload(c);
  const parsed = updateOperatorSchema.safeParse(body);
  if (!parsed.success) {
    throw new BadRequestError(
      parsed.error.issues[0]?.message || "Invalid operator update payload",
    );
  }

  const updated = await OperatorsService.updateManual(
    c.req.param("id"),
    parsed.data,
    imageFile,
  );
  return c.json(successResponse("Operator updated successfully", updated));
});

operatorsRoutes.delete("/:id", requireAuth, requireAdmin, async (c) => {
  const result = await OperatorsService.remove(c.req.param("id"));
  return c.json(
    successResponse(
      result.deleted ? "Operator deleted" : "Operator disabled",
      result,
    ),
  );
});

operatorsRoutes.get("/:slug", async (c) => {
  const wantsDisabled = c.req.query("includeDisabled") === "true";
  const includeDisabled = wantsDisabled && canViewDisabled(c);
  const operator = await OperatorsService.getBySlug(
    c.req.param("slug"),
    includeDisabled,
  );
  return c.json(successResponse("Operator retrieved successfully", operator));
});
