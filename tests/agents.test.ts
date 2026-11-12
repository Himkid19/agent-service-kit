import { describe, it, expect, beforeAll } from "vitest";
import { agentService } from "../src/services/agent.service.js";
import { workspaceManager } from "../src/services/workspace.service.js";
import { authService } from "../src/services/auth.service.js";
import { config } from "../src/config.js";
import { loadSkillsFromDir } from "@earendil-works/pi-coding-agent";
import { writeFile, mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { existsSync } from "node:fs";
import { resetAllTables } from "./db-test-utils.js";

describe("Agent Service", () => {
  beforeAll(async () => {
    // Use test directories
    config.workplacesDir = config.workplacesDir + "-test";
    config.dataDir = config.dataDir + "-test";
    config.agentsFile = config.dataDir + "/agents.json";

    // Clean workspace dir from previous runs
    if (existsSync(config.workplacesDir)) {
      await rm(config.workplacesDir, { recursive: true, force: true });
    }

    await resetAllTables();
    await authService.init();
    await workspaceManager.init();
    await agentService.init();
  });

  it("should create an agent with workspace", async () => {
    const agent = await agentService.create({
      name: "my-agent",
      description: "My test agent",
      allowedTools: ["read", "grep"],
      defaultProvider: "openai",
      defaultModel: "gpt-4o",
    });

    expect(agent.id).toMatch(/^agent-/);
    expect(agent.name).toBe("my-agent");
    expect(agent.allowedTools).toEqual(["read", "grep"]);
    expect(agent.workspacePath).toContain(agent.id);

    // Workspace should exist
    const ws = workspaceManager.get(agent.id);
    expect(ws).toBeDefined();
    expect(ws!.hasAgentMd).toBe(true);
  });

  it("should list all agents", async () => {
    const agents = await agentService.list();
    expect(agents.length).toBeGreaterThanOrEqual(1);
  });

  it("should get agent by id", async () => {
    const agents = await agentService.list();
    const agent = await agentService.get(agents[0].id);
    expect(agent).toBeDefined();
    expect(agent!.id).toBe(agents[0].id);
  });

  it("should update agent config", async () => {
    const agents = await agentService.list();
    const updated = await agentService.update(agents[0].id, {
      name: "renamed-agent",
      allowedTools: ["read"],
    });
    expect(updated.name).toBe("renamed-agent");
    expect(updated.allowedTools).toEqual(["read"]);
  });

  it("should update agent by name as well as id", async () => {
    const agents = await agentService.list();
    // Regressions for the "Agent not found" bug: update()/delete() used to
    // resolve service ids only, while get() also accepted names.
    const byName = await agentService.update(agents[0].name, { description: "via-name" });
    expect(byName).toBeDefined();
    expect(byName.id).toBe(agents[0].id);
    expect(byName.description).toBe("via-name");
    await agentService.delete(agents[0].name);
    expect(await agentService.get(agents[0].id)).toBeUndefined();
  });

  it("should throw Agent not found for unknown id on update", async () => {
    await expect(agentService.update("no-such-agent", { description: "x" }))
      .rejects.toThrow("Agent not found");
  });

  it("should return undefined for non-existent agent", async () => {
    const agent = await agentService.get("non-existent");
    expect(agent).toBeUndefined();
  });

  it("should create agents with isolated workspaces", async () => {
    const agent1 = await agentService.create({
      name: "isolated-1",
      description: "",
    });
    const agent2 = await agentService.create({
      name: "isolated-2",
      description: "",
    });

    expect(agent1.workspacePath).toContain(agent1.id);
    expect(agent2.workspacePath).toContain(agent2.id);
    expect(agent1.workspacePath).not.toBe(agent2.workspacePath);
  });

  it("should delete an agent", async () => {
    const agent = await agentService.create({
      name: "to-delete",
      description: "",
    });
    expect(await agentService.get(agent.id)).toBeDefined();

    await agentService.delete(agent.id);
    expect(await agentService.get(agent.id)).toBeUndefined();
  });

  it("should support workspace skills loaded via SDK", async () => {
    const agent = await agentService.create({
      name: "skill-agent",
      description: "Has skills",
    });

    // SDK discovers skills from subdirectories containing SKILL.md
    const skillDir = resolve(agent.workspacePath, "skills");
    await mkdir(resolve(skillDir, "data-lookup"), { recursive: true });
    await mkdir(resolve(skillDir, "report-gen"), { recursive: true });
    await writeFile(
      resolve(skillDir, "data-lookup", "SKILL.md"),
      `---
name: Data Lookup
description: Help the user look up data from the database.
---

# Data Lookup

Look up data from database tables.
`,
      "utf-8",
    );
    await writeFile(
      resolve(skillDir, "report-gen", "SKILL.md"),
      `---
name: Report Generation
description: Generate formatted reports from query results.
---

# Report Generation

Create reports in various formats.
`,
      "utf-8",
    );

    // Verify the SDK can discover these skills
    const loaded = loadSkillsFromDir({ dir: skillDir, source: "workspace" });
    expect(loaded.skills.length).toBe(2);
    const names = loaded.skills.map((s) => s.name);
    expect(names).toContain("Data Lookup");
    expect(names).toContain("Report Generation");
  });
});
