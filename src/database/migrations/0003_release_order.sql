DROP INDEX IF EXISTS "operators_release_date_idx";--> statement-breakpoint
ALTER TABLE "operators" DROP COLUMN IF EXISTS "release_date";--> statement-breakpoint
ALTER TABLE "operators" ADD COLUMN IF NOT EXISTS "release_order" integer;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "operators_release_order_idx" ON "operators" USING btree ("release_order");
