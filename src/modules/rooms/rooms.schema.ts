import { z } from "zod";

const VALID_CLASSES = [
  "Vanguard",
  "Guard",
  "Defender",
  "Sniper",
  "Caster",
  "Medic",
  "Supporter",
  "Specialist",
] as const;

export const createRoomSchema = z.object({
  name: z
    .string()
    .trim()
    .min(2, "Room name must be at least 2 characters")
    .max(60, "Room name must be at most 60 characters"),
  password: z
    .string()
    .max(64, "Password is too long")
    .optional()
    .transform((v) => (v && v.trim().length > 0 ? v.trim() : undefined)),
  maxPlayers: z.coerce.number().int().min(2).max(10).default(6),
  lives: z.coerce.number().int().min(1).max(10).default(3),
  turnTimerSeconds: z
    .union([z.null(), z.literal(""), z.coerce.number().int().min(15).max(300)])
    .optional()
    .transform((v) => (v === "" || v === undefined ? null : v)),
  allowPass: z.boolean().default(true),
  maxQuestionsPerTurn: z.coerce.number().int().min(1).max(5).default(1),
  rarities: z.array(z.coerce.number().int().min(1).max(6)).default([4, 5, 6]),
  classes: z.array(z.enum(VALID_CLASSES)).default([]),
});

export const updateRoomSettingsSchema = z.object({
  name: z
    .string()
    .trim()
    .min(2, "Room name must be at least 2 characters")
    .max(60, "Room name must be at most 60 characters")
    .optional(),
  password: z.string().max(64, "Password is too long").optional(),
  maxPlayers: z.coerce.number().int().min(2).max(10).optional(),
  lives: z.coerce.number().int().min(1).max(10).optional(),
  turnTimerSeconds: z
    .union([z.null(), z.literal(""), z.coerce.number().int().min(15).max(300)])
    .optional()
    .transform((v) => (v === "" ? null : v)),
  allowPass: z.boolean().optional(),
  maxQuestionsPerTurn: z.coerce.number().int().min(1).max(5).optional(),
  rarities: z.array(z.coerce.number().int().min(1).max(6)).min(1).optional(),
  classes: z.array(z.enum(VALID_CLASSES)).optional(),
});

export const joinRoomSchema = z.object({
  password: z.string().max(64).optional(),
});

export type CreateRoomInput = z.infer<typeof createRoomSchema>;
export type UpdateRoomSettingsInput = z.infer<typeof updateRoomSettingsSchema>;
export type JoinRoomInput = z.infer<typeof joinRoomSchema>;
