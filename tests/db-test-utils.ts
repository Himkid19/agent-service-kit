import { config } from "../src/config.js";
import { db } from "../src/db.js";

const TABLES = ["messages", "sessions", "provider_models", "providers", "agents", "users"];

function assertTestDatabase(): void {
  if (!config.dbName.toLowerCase().includes("test")) {
    throw new Error(
      `Refusing to reset non-test database "${config.dbName}". Tests must target a database with "test" in its name. Set TEST_DB_NAME or check DB_NAME.`
    );
  }
}

export async function resetAllTables(): Promise<void> {
  assertTestDatabase();
  await db.query("SET FOREIGN_KEY_CHECKS = 0");
  try {
    for (const table of TABLES) {
      await db.execute(`TRUNCATE TABLE ${table}`);
    }
  } finally {
    await db.query("SET FOREIGN_KEY_CHECKS = 1");
  }
}

export async function resetTables(...tables: string[]): Promise<void> {
  assertTestDatabase();
  await db.query("SET FOREIGN_KEY_CHECKS = 0");
  try {
    for (const table of tables) {
      await db.execute(`TRUNCATE TABLE ${table}`);
    }
  } finally {
    await db.query("SET FOREIGN_KEY_CHECKS = 1");
  }
}
