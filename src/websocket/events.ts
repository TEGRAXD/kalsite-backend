import { z } from "zod";

export const wsClientEventSchema = z.discriminatedUnion("event", [
  z.object({
    event: z.literal("rooms:subscribe"),
    payload: z.object({}).optional(),
  }),
  z.object({
    event: z.literal("rooms:unsubscribe"),
    payload: z.object({}).optional(),
  }),
  z.object({
    event: z.literal("room:subscribe"),
    payload: z.object({
      roomCode: z.string().trim().min(4).max(16),
    }),
  }),
  z.object({
    event: z.literal("room:ready"),
    payload: z.object({
      ready: z.boolean(),
    }),
  }),
  z.object({
    event: z.literal("room:color"),
    payload: z.object({
      color: z.string().trim().min(4).max(16),
    }),
  }),
  z.object({
    event: z.literal("room:chat"),
    payload: z.object({
      message: z.string().trim().min(1).max(400),
    }),
  }),
  z.object({
    event: z.literal("room:spectator-chat"),
    payload: z.object({
      message: z.string().trim().min(1).max(400),
    }),
  }),
  z.object({
    event: z.literal("room:clue"),
    payload: z.object({
      targetUserId: z.string().min(1).optional(),
      attribute: z.enum(["class", "rarity", "faction", "race", "branch", "hint"]),
      value: z.string().trim().min(1).max(160),
    }),
  }),
  z.object({
    event: z.literal("game:ask"),
    payload: z.object({
      question: z.string().trim().min(1).max(240),
    }),
  }),
  z.object({
    event: z.literal("game:answer"),
    payload: z.object({
      questionId: z.string().min(1),
      answer: z.enum(["yes", "no", "unsure"]),
    }),
  }),
  z.object({
    event: z.literal("game:reaction"),
    payload: z.object({
      reaction: z.enum([
        "warm",
        "cold",
        "close",
        "yes",
        "no",
        "thinking",
        "applause",
      ]),
    }),
  }),
  z.object({
    event: z.literal("game:guess"),
    payload: z.object({
      operatorId: z.string().min(1),
      clientActionId: z.string().max(64).optional(),
    }),
  }),
  z.object({
    event: z.literal("game:pass"),
    payload: z.object({
      clientActionId: z.string().max(64).optional(),
    }),
  }),
]);

export type WsClientEvent = z.infer<typeof wsClientEventSchema>;
