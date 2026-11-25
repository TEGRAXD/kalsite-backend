ALTER TABLE "operators" ADD COLUMN "release_date" varchar(20);--> statement-breakpoint
CREATE INDEX "operators_release_date_idx" ON "operators" USING btree ("release_date");