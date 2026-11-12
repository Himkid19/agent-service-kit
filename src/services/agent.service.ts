import { randomUUID } from "node:crypto";
import { readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { existsSync } from "node:fs";
import { config } from "../config.js";
import { workspaceManager, toLocalWorkspacePath, toStoredWorkspacePath } from "./workspace.service.js";
import { agentRepository, type StoredAgent } from "../repositories/agent.repository.js";
import { db } from "../db.js";
import type { AgentConfig } from "../types.js";
import { createLogger } from "../logger.js";
const log = createLogger("agent");

class AgentService {
  async create(opts: {
    name: string;
    description: string;
    allowedTools?: string[];
    defaultProvider?: string;
    defaultModel?: string;
    defaultThinkingLevel?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
    systemPrompt?: string;
    ownerId?: string;
  }): Promise<AgentConfig> {
    const agentId = `agent-${randomUUID().slice(0, 8)}`;
    const workspacePath = await workspaceManager.create({ agentId, name: opts.name });

    if (opts.systemPrompt) {
      await workspaceManager.writeAgentMd(agentId, opts.systemPrompt);
    }

    const agent: StoredAgent = {
      id: agentId,
      name: opts.name,
      description: opts.description,
      defaultProvider: opts.defaultProvider,
      defaultModel: opts.defaultModel,
      defaultThinkingLevel: opts.defaultThinkingLevel,
      allowedTools: opts.allowedTools ?? ["read", "grep", "find", "ls"],
      workspacePath,
      ownerId: opts.ownerId,
      isGlobal: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    await agentRepository.create(agent);
    return agentRepository.toConfig(agent);
  }

  async get(idOrName: string): Promise<AgentConfig | undefined> {
    const a = await agentRepository.findById(idOrName) ?? await agentRepository.findByName(idOrName);
    return a ? agentRepository.toConfig(a) : undefined;
  }

  async list(): Promise<AgentConfig[]> {
    const agents = await agentRepository.list();
    return agents.map((a) => agentRepository.toConfig(a));
  }

  async update(
    id: string,
    updates: Partial<Pick<StoredAgent, "name" | "description" | "defaultProvider" | "defaultModel" | "defaultThinkingLevel" | "allowedTools" | "ownerId" | "isGlobal">> & { systemPrompt?: string },
  ): Promise<AgentConfig> {
    // Accept either the agent id or its name (consistent with get()).
    const agent = await agentRepository.findById(id) ?? await agentRepository.findByName(id);
    if (!agent) throw new Error(`Agent not found: ${id}`);

    if (updates.systemPrompt !== undefined) {
      await workspaceManager.writeAgentMd(id, updates.systemPrompt);
    }

    const dbUpdates: Partial<StoredAgent> = { ...updates };
    delete (dbUpdates as any).systemPrompt; // stored in workspace file

    await agentRepository.update(agent.id, dbUpdates);
    const updated = await agentRepository.findById(agent.id);
    return agentRepository.toConfig(updated!);
  }

  async delete(id: string): Promise<void> {
    // Same id-or-name resolution as update()/get(): operate on the resolved
    // agent's id so repository calls (WHERE id = ?) always hit the row.
    const agent = await agentRepository.findById(id) ?? await agentRepository.findByName(id);
    if (!agent) throw new Error(`Agent not found: ${id}`);
    await agentRepository.delete(agent.id);

    if (agent.workspacePath && existsSync(agent.workspacePath)) {
      await rm(agent.workspacePath, { recursive: true, force: true });
    }
    workspaceManager.remove(agent.id);
  }

  /** Seed a test agent for development/testing */
  async seedTestAgent(): Promise<AgentConfig> {
    const existing = await agentRepository.findByName("test-agent");
    if (existing) {
      if (existing.defaultProvider !== config.defaultProvider || existing.defaultModel !== config.defaultModel) {
        await agentRepository.update(existing.id, {
          defaultProvider: config.defaultProvider,
          defaultModel: config.defaultModel,
        });
      }
      return agentRepository.toConfig(existing);
    }

    return this.create({
      name: "test-agent",
      description: "Default test agent for development and unit testing",
      allowedTools: ["read", "grep", "find", "ls"],
      defaultProvider: config.defaultProvider,
      defaultModel: config.defaultModel,
    });
  }

  async init(): Promise<void> {
    await this.normalizeStoredWorkspacePaths();
    await this.seedBakedAgents();
    if (config.pruneStaleAgents) {
      await this.pruneStaleAgents();
    }
  }

  /** Re-persist legacy absolute workspace paths in the portable relative
   *  form (relative to workplacesDir), so a MySQL database shared between
   *  machines (Windows dev / CentOS server) resolves correctly on each. */
  private async normalizeStoredWorkspacePaths(): Promise<void> {
    const rows = await db.query("SELECT id, workspace_path FROM agents");
    for (const row of rows as Array<{ id: string; workspace_path: string }>) {
      const desired = toStoredWorkspacePath(toLocalWorkspacePath(row.workspace_path));
      if (row.workspace_path !== desired) {
        log.info(`normalizing workspace path for agent ${row.id}: ${row.workspace_path} -> ${desired}`);
        await agentRepository.update(row.id, { workspacePath: desired });
      }
    }
  }

  /** Delete persisted agents whose workspace directory no longer exists (opt-in via PRUNE_STALE_AGENTS) */
  private async pruneStaleAgents(): Promise<void> {
    const agents = await agentRepository.list();
    for (const a of agents) {
      if (!existsSync(a.workspacePath)) {
        log.warn(`pruning stale agent "${a.name}" (${a.id}): workspace missing at ${a.workspacePath}`);
        await agentRepository.delete(a.id);
      }
    }
  }

  /** Load pre-baked agents from the agents file (e.g. shipped with Docker) into MySQL */
  private async seedBakedAgents(): Promise<void> {
    const agentsFile = config.agentsFile;
    if (!existsSync(agentsFile)) return;
    const raw = await readFile(agentsFile, "utf-8");
    let arr: StoredAgent[];
    try {
      arr = JSON.parse(raw);
    } catch {
      log.warn(`failed to parse ${agentsFile}`);
      return;
    }

    for (const a of arr) {
      // Resolve the stored (relative or legacy absolute) path to this machine
      a.workspacePath = toLocalWorkspacePath(a.workspacePath);
      // Validate workspace exists
      if (!existsSync(a.workspacePath)) {
        const candidate = resolve(config.workplacesDir, a.id);
        if (existsSync(candidate)) {
          a.workspacePath = candidate;
        } else {
          log.warn(`skipping baked "${a.name}" (${a.id}): workspace missing at ${a.workspacePath}`);
          continue;
        }
      }

      const existing = await agentRepository.findById(a.id);
      if (existing) {
        // Update workspace path if it changed (e.g. Docker vs local)
        if (existing.workspacePath !== a.workspacePath) {
          await agentRepository.update(a.id, { workspacePath: a.workspacePath });
        }
      } else {
        await agentRepository.create({
          ...a,
          isGlobal: a.isGlobal ?? true, // pre-baked agents are global by default
          ownerId: a.ownerId, // usually undefined for pre-baked
        });
      }
    }
  }

  /** Save agents to file — kept for compatibility but no longer used at runtime */
  async saveToFile(): Promise<void> {
    await mkdir(config.dataDir, { recursive: true });
    const agents = await agentRepository.list();
    await writeFile(
      config.agentsFile,
      JSON.stringify(agents.map((a) => ({
        ...a,
        allowedTools: a.allowedTools,
      })), null, 2),
      "utf-8",
    );
  }
}

export const agentService = new AgentService();
