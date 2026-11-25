import { z } from "zod";

export const VALID_OPERATOR_CLASSES = [
  "Vanguard",
  "Guard",
  "Defender",
  "Sniper",
  "Caster",
  "Medic",
  "Supporter",
  "Specialist",
] as const;

export const syncOperatorsSchema = z
  .object({
    forceRedownloadImages: z.boolean().optional().default(false),
  })
  .optional();

export const createOperatorSchema = z.object({
  name: z.string().trim().min(1, "Name is required").max(100),
  latinName: z
    .string()
    .trim()
    .max(100)
    .optional()
    .transform((v) => (v && v.length > 0 ? v : undefined)),
  cnName: z.string().trim().min(1, "CN name is required").max(100),
  slug: z
    .string()
    .trim()
    .max(100)
    .optional()
    .transform((v) => (v && v.length > 0 ? v : undefined)),
  rarity: z.coerce.number().int().min(1).max(6),
  operatorClass: z.enum(VALID_OPERATOR_CLASSES),
  branch: z.string().trim().min(1, "Branch is required").max(60),
  faction: z
    .string()
    .trim()
    .max(80)
    .optional()
    .transform((v) => (v && v.length > 0 ? v : undefined)),
  releaseOrder: z.coerce.number().int().optional(),
  sourceImageUrl: z
    .string()
    .trim()
    .optional()
    .transform((v) => (v && v.length > 0 ? v : undefined)),
});

export const updateOperatorSchema = z.object({
  name: z.string().trim().min(1, "Name is required").max(100).optional(),
  latinName: z
    .string()
    .trim()
    .max(100)
    .nullable()
    .optional()
    .transform((v) => (v === undefined ? undefined : v && v.length > 0 ? v : null)),
  cnName: z.string().trim().min(1, "CN name is required").max(100).optional(),
  slug: z
    .string()
    .trim()
    .max(100)
    .optional()
    .transform((v) => (v && v.length > 0 ? v : undefined)),
  rarity: z.coerce.number().int().min(1).max(6).optional(),
  operatorClass: z.enum(VALID_OPERATOR_CLASSES).optional(),
  branch: z.string().trim().min(1, "Branch is required").max(60).optional(),
  faction: z
    .string()
    .trim()
    .max(80)
    .nullable()
    .optional()
    .transform((v) => (v === undefined ? undefined : v && v.length > 0 ? v : null)),
  releaseOrder: z
    .union([z.number(), z.string(), z.null()])
    .optional()
    .transform((v) => {
      if (v === undefined) return undefined;
      if (v === null || v === "") return null;
      const n = Number(v);
      return Number.isInteger(n) ? n : undefined;
    }),
  sourceImageUrl: z
    .string()
    .trim()
    .optional()
    .transform((v) => (v && v.length > 0 ? v : undefined)),
  isEnabled: z
    .union([z.boolean(), z.enum(["true", "false"])])
    .optional()
    .transform((v) =>
      v === undefined ? undefined : typeof v === "boolean" ? v : v === "true",
    ),
});

export type CreateOperatorInput = z.infer<typeof createOperatorSchema>;
export type UpdateOperatorInput = z.infer<typeof updateOperatorSchema>;
