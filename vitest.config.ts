import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globalSetup: "./vitest.global.ts",
    setupFiles: ["./tests/setup.ts"],
    pool: "forks",
    // Every test file shares one MySQL database and truncates it in beforeAll.
    // Running files concurrently would interleave resets and inserts.
    fileParallelism: false,
    maxWorkers: 1,
  },
});
