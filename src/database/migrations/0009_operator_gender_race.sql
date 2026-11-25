ALTER TABLE "operators"
  ADD COLUMN IF NOT EXISTS "gender" varchar(30);

ALTER TABLE "operators"
  ADD COLUMN IF NOT EXISTS "race" varchar(60);

CREATE INDEX IF NOT EXISTS "operators_gender_idx" ON "operators" ("gender");
CREATE INDEX IF NOT EXISTS "operators_race_idx" ON "operators" ("race");
