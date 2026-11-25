import "dotenv/config";
import { db, pool, ROLE_IDS, roles } from "../index";
import { syncOperatorsFromGitHub } from "../../modules/operators/operators.sync";

async function seedDefaultRoles() {
  await db
    .insert(roles)
    .values([
      {
        id: ROLE_IDS.SUPER_ADMIN,
        name: "Super Administrator",
        description: "Full access to users, roles, rooms, and operator sync",
      },
      {
        id: ROLE_IDS.ADMIN,
        name: "Administrator",
        description: "Manage operators and moderate rooms",
      },
      {
        id: ROLE_IDS.USER,
        name: "User",
        description: "Standard member access",
      },
    ])
    .onConflictDoNothing();
}

async function runSeed() {
  await seedDefaultRoles();
  await syncOperatorsFromGitHub();
}

runSeed()
  .catch((err) => {
    console.error("[db:seed] Failed to run seed:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
