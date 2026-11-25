import "dotenv/config";
import { z } from "zod";

const envSchema = z.object({
  NODE_ENV: z
    .enum(["development", "production", "test"])
    .default("development"),
  API_HOST: z.string().default("localhost"),
  API_PORT: z.coerce.number().int().positive().default(5000),
  WEB_URL: z
    .string()
    .trim()
    .url()
    .default("http://localhost:3000")
    .transform((v) => v.replace(/\/+$/, "")),
  DATABASE_URL: z
    .string()
    .min(1)
    .default("postgres://postgres:root@localhost:5432/kalsite"),
  DISCORD_CLIENT_ID: z.string().trim().default(""),
  DISCORD_CLIENT_SECRET: z.string().trim().default(""),
  DISCORD_REDIRECT_URI: z
    .string()
    .trim()
    .default("http://localhost:5000/auth/discord/callback"),
  COOKIE_DOMAIN: z.string().trim().default(""),
  SESSION_SECRET: z
    .string()
    .default("kalsite-dev-session-secret-change-in-production"),
  API_SECRET_KEY: z
    .string()
    .min(1)
    .default("kalsite-dev-api-secret-change-in-production"),
  SUPER_ADMIN_DISCORD_IDS: z.string().default(""),
  ALLOW_DEV_LOGIN: z
    .enum(["true", "false"])
    .default("true")
    .transform((v) => v === "true"),
  SYSTEM_NAME: z.string().trim().min(1).default("ZOOT"),
});

export const env = envSchema.parse(process.env);

export const SYSTEM_NAME = env.SYSTEM_NAME;

export const SUPER_ADMIN_IDS = new Set(
  env.SUPER_ADMIN_DISCORD_IDS.split(",")
    .map((s) => s.trim())
    .filter(Boolean),
);

export const isDiscordConfigured = Boolean(
  env.DISCORD_CLIENT_ID && env.DISCORD_CLIENT_SECRET,
);
