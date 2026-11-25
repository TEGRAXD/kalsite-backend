ALTER TABLE "operators" ADD COLUMN IF NOT EXISTS "faction" varchar(80);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "operators_faction_idx" ON "operators" USING btree ("faction");
