// Vitest setup file: runs before each test file, in the same process context.
// This sets DB_NAME to the dedicated test database and ensures the MySQL pool is initialized.
process.env.DB_HOST = process.env.DB_HOST || "127.0.0.1";
process.env.DB_PORT = process.env.DB_PORT || "3306";
process.env.DB_USER = process.env.DB_USER || "root";
process.env.DB_NAME = process.env.TEST_DB_NAME || "agent_service_kit_test";

await (async () => {
  const { db } = await import("../src/db.js");
  await db.init();
})();
