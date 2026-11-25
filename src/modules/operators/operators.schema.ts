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

export const updateOperatorSchema = createOperatorSchema.partial().extend({
  isEnabled: z.boolean().optional(),
});

export type CreateOperatorInput = z.infer<typeof createOperatorSchema>;
export type UpdateOperatorInput = z.infer<typeof updateOperatorSchema>;
