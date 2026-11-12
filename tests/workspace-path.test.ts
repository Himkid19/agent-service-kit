import { describe, it, expect } from "vitest";
import { resolve } from "node:path";
import { config } from "../src/config.js";
import { toLocalWorkspacePath, toStoredWorkspacePath } from "../src/services/workspace.service.js";

const norm = (p: string) => p.replace(/\\/g, "/");

describe("workspace path portability helpers", () => {
  it("stores an absolute path under workplacesDir as relative", () => {
    const abs = resolve(config.workplacesDir, "agent-abc123");
    expect(toStoredWorkspacePath(abs)).toBe("agent-abc123");
  });

  it("keeps an already-relative stored path unchanged (forward slashes)", () => {
    expect(toStoredWorkspacePath("agent-abc123")).toBe("agent-abc123");
    expect(toStoredWorkspacePath("nested\\agent-x")).toBe("nested/agent-x");
  });

  it("reduces a foreign Linux absolute path to its directory name", () => {
    expect(toStoredWorkspacePath("/app/workplaces/agent-abc123")).toBe("agent-abc123");
  });

  it("reduces a foreign Windows absolute path to its directory name", () => {
    expect(toStoredWorkspacePath("C:\\Users\\dev\\workplaces\\agent-abc123")).toBe("agent-abc123");
  });

  it("resolves a relative stored path under the local workplacesDir", () => {
    const local = toLocalWorkspacePath("agent-abc123");
    expect(norm(local)).toBe(norm(resolve(config.workplacesDir, "agent-abc123")));
  });

  it("keeps a local absolute path as-is", () => {
    const abs = resolve(config.workplacesDir, "agent-abc123");
    expect(toLocalWorkspacePath(abs)).toBe(abs);
  });

  it("maps a foreign Linux absolute path onto the local workplacesDir", () => {
    const local = toLocalWorkspacePath("/app/workplaces/openmetadata-model-sql-agent");
    expect(norm(local)).toBe(norm(resolve(config.workplacesDir, "openmetadata-model-sql-agent")));
  });

  it("maps a foreign Windows absolute path onto the local workplacesDir", () => {
    const local = toLocalWorkspacePath("C:\\Users\\dev\\agent-service-kit\\workplaces\\agent-abc123");
    expect(norm(local)).toBe(norm(resolve(config.workplacesDir, "agent-abc123")));
  });

  it("round-trips: store(local(x)) === x for stored relative paths", () => {
    for (const stored of ["agent-abc123", "openmetadata-model-sql-agent"]) {
      expect(toStoredWorkspacePath(toLocalWorkspacePath(stored))).toBe(stored);
    }
  });
});
