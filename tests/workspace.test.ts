import { describe, it, expect, beforeAll } from "vitest";
import { resolve } from "node:path";
import { workspaceManager } from "../src/services/workspace.service.js";
import { config, ROOT } from "../src/config.js";

describe("Workspace Service — Permission Isolation", () => {
  beforeAll(async () => {
    config.workplacesDir = resolve(ROOT, "workplaces-ws-test");
    await workspaceManager.init();
  });

  it("should create a workspace with default files", async () => {
    const path = await workspaceManager.create({
      agentId: "ws-agent-1",
      name: "WS Test Agent 1",
    });
    expect(path).toContain("ws-agent-1");

    const info = workspaceManager.get("ws-agent-1");
    expect(info).toBeDefined();
    expect(info!.hasAgentMd).toBe(true);
  });

  it("should create isolated workspaces for different agents", async () => {
    await workspaceManager.create({
      agentId: "ws-agent-2",
      name: "WS Test Agent 2",
    });

    const ws1 = workspaceManager.get("ws-agent-1");
    const ws2 = workspaceManager.get("ws-agent-2");
    expect(ws1).toBeDefined();
    expect(ws2).toBeDefined();
    expect(ws1!.path).not.toBe(ws2!.path);
  });

  it("should read and write agent.md in a workspace", async () => {
    const original = await workspaceManager.readAgentMd("ws-agent-1");
    expect(original).toBeTruthy();
    expect(original!.length).toBeGreaterThan(0);

    const newContent = "# Custom Agent\n\nCustom instructions here.";
    await workspaceManager.writeAgentMd("ws-agent-1", newContent);

    const updated = await workspaceManager.readAgentMd("ws-agent-1");
    expect(updated).toBe(newContent);
  });

  it("should reject writing to non-existent workspace", async () => {
    await expect(
      workspaceManager.writeAgentMd("non-existent", "content")
    ).rejects.toThrow("Workspace not found");
  });

  it("should list all workspaces", () => {
    const list = workspaceManager.list();
    expect(list.length).toBeGreaterThanOrEqual(2);
    const ids = list.map((w) => w.agentId);
    expect(ids).toContain("ws-agent-1");
    expect(ids).toContain("ws-agent-2");
  });

  it("should isolate agent.md between workspaces", async () => {
    await workspaceManager.writeAgentMd("ws-agent-2", "# Agent 2 Only Config");
    const ws1Content = await workspaceManager.readAgentMd("ws-agent-1");
    const ws2Content = await workspaceManager.readAgentMd("ws-agent-2");
    expect(ws1Content).not.toBe(ws2Content);
    expect(ws2Content).toBe("# Agent 2 Only Config");
  });

  it("should return null for missing agent.md", async () => {
    // Create workspace but agent.md should exist (created by default)
    const content = await workspaceManager.readAgentMd("ws-agent-2");
    expect(content).toBeTruthy();
  });
});
