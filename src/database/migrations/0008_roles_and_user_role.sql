CREATE TABLE IF NOT EXISTS "roles" (
  "id" varchar(40) PRIMARY KEY NOT NULL,
  "name" varchar(80) NOT NULL,
  "description" varchar(255),
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

INSERT INTO "roles" ("id", "name", "description")
VALUES
  ('super-administrator', 'Super Administrator', 'Full access to users, roles, rooms, and operator sync'),
  ('administrator', 'Administrator', 'Manage operators and moderate rooms'),
  ('user', 'User', 'Standard member access')
ON CONFLICT ("id") DO NOTHING;

ALTER TABLE "users"
  ADD COLUMN IF NOT EXISTS "role_id" varchar(40) NOT NULL DEFAULT 'user';

ALTER TABLE "users"
  ADD COLUMN IF NOT EXISTS "updated_at" timestamp with time zone DEFAULT now() NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'users_role_id_roles_id_fk'
  ) THEN
    ALTER TABLE "users"
      ADD CONSTRAINT "users_role_id_roles_id_fk"
      FOREIGN KEY ("role_id") REFERENCES "roles"("id")
      ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;
