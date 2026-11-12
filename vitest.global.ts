import { existsSync, rmSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * Global Vitest setup ¡ª runs once before all test files in a separate process.
 * Cleans test artifact directories from previous runs.
 */
export function setup(): void {
  const cwd = process.cwd();

  for (const entry of readdirSync(cwd, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const name = entry.name;

    if (
      (name.startsWith("data-") || name.startsWith("workplaces-")) &&
      (name.endsWith("-test") || name.endsWith("-ws-test"))
    ) {
      rmSync(join(cwd, name), { recursive: true, force: true });
    }
  }
}

export function teardown(): void {
  // noop
}
