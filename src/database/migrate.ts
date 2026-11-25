import "dotenv/config";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { drizzle } from "drizzle-orm/node-postgres";
import { Client, Pool } from "pg";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { env } from "../config";
import * as schema from "./schema";

const __dirname = dirname(fileURLToPath(import.meta.url));

async function ensureDatabaseExists(databaseUrl: string) {
  const parsed = new URL(databaseUrl);
  const dbName = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
  if (!dbName) return;

  const adminUrl = new URL(databaseUrl);
  adminUrl.pathname = "/postgres";

  const client = new Client({ connectionString: adminUrl.toString() });
  await client.connect();
  try {
    const exists = await client.query(
      "SELECT 1 FROM pg_database WHERE datname = $1",
      [dbName],
    );
    if (exists.rowCount === 0) {
      const safeName = dbName.replace(/"/g, '""');
      await client.query(`CREATE DATABASE "${safeName}"`);
      console.log(`[db:migrate] Created PostgreSQL database "${dbName}".`);
    }
  } finally {
    await client.end();
  }
}

async function runMigrate() {
  console.log("[db:migrate] Ensuring PostgreSQL database exists...");
  await ensureDatabaseExists(env.DATABASE_URL);

  const pool = new Pool({
    connectionString: env.DATABASE_URL,
  });

  try {
    console.log("[db:migrate] Running Drizzle PostgreSQL migrations...");
    const migrationDb = drizzle(pool, { schema });
    await migrate(migrationDb, {
      migrationsFolder: join(__dirname, "migrations"),
    });
    console.log("[db:migrate] Migrations applied successfully!");
  } catch (error) {
    console.error("[db:migrate] Migration failed:", error);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

runMigrate();
