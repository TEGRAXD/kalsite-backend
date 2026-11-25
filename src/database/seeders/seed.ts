import "dotenv/config";
import { pool } from "../index";
import { syncOperatorsFromGitHub } from "../../modules/operators/operators.sync";

async function runSeed() {
  await syncOperatorsFromGitHub();
}

runSeed()
  .catch((err) => {
    console.error("[db:seed] Failed to sync operators:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
