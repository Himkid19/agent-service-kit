import { randomUUID } from "node:crypto";
import { db, toMySqlDateTime } from "../db.js";
import { toLocalWorkspacePath, toStoredWorkspacePath } from "../services/workspace.service.js";
import type { AgentConfig } from "../types.js";

export interface StoredAgent {
  id: string;
  name: string;
  description: string;
  defaultProvider?: string;
  defaultModel?: string;
  defaultThinkingLevel?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
  allowedTools: string[];
  workspacePath: string;
  ownerId?: string;
  isGlobal: boolean;
  createdAt: string;
  updatedAt: string;
}

interface AgentRow {
  id: string;
  name: string;
  description: string;
  default_provider: string | null;
  default_model: string | null;
  default_thinking_level: string | null;
  allowed_tools: string;
  workspace_path: string;
  owner_id: string | null;
  is_global: number;
  created_at: string;
  updated_at: string;
}

function rowToStoredAgent(row: AgentRow): StoredAgent {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    defaultProvider: row.default_provider ?? undefined,
    defaultModel: row.default_model ?? undefined,
    defaultThinkingLevel: (row.default_thinking_level ?? undefined) as any,
    allowedTools: Array.isArray(row.allowed_tools) ? row.allowed_tools : JSON.parse(row.allowed_tools),
    workspacePath: toLocalWorkspacePath(row.workspace_path),
    ownerId: row.owner_id ?? undefined,
    isGlobal: Boolean(row.is_global),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export const agentRepository = {
  async create(agent: StoredAgent): Promise<void> {
    await db.execute(
      `INSERT INTO agents (id, name, description, default_provider, default_model, default_thinking_level,
         allowed_tools, workspace_path, owner_id, is_global, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        agent.id,
        agent.name,
        agent.description,
        agent.defaultProvider ?? null,
        agent.defaultModel ?? null,
        agent.defaultThinkingLevel ?? null,
        JSON.stringify(agent.allowedTools),
        toStoredWorkspacePath(agent.workspacePath),
        agent.ownerId ?? null,
        agent.isGlobal ? 1 : 0,
        toMySqlDateTime(agent.createdAt),
        toMySqlDateTime(agent.updatedAt),
      ],
    );
  },

  async findById(id: string): Promise<StoredAgent | undefined> {
    const rows = await db.query(
      "SELECT * FROM agents WHERE id = ?",
      [id],
    );
    if (rows.length === 0) return undefined;
    return rowToStoredAgent(rows[0] as unknown as AgentRow);
  },

  async findByName(name: string): Promise<StoredAgent | undefined> {
    const rows = await db.query(
      "SELECT * FROM agents WHERE name = ?",
      [name],
    );
    if (rows.length === 0) return undefined;
    return rowToStoredAgent(rows[0] as unknown as AgentRow);
  },

  async list(): Promise<StoredAgent[]> {
    const rows = await db.query("SELECT * FROM agents ORDER BY created_at DESC");
    return rows.map((r) => rowToStoredAgent(r as unknown as AgentRow));
  },

  async update(id: string, updates: Partial<StoredAgent>): Promise<void> {
    const sets: string[] = [];
    const values: any[] = [];

    if (updates.name !== undefined) { sets.push("name = ?"); values.push(updates.name); }
    if (updates.description !== undefined) { sets.push("description = ?"); values.push(updates.description); }
    if (updates.defaultProvider !== undefined) { sets.push("default_provider = ?"); values.push(updates.defaultProvider); }
    if (updates.defaultModel !== undefined) { sets.push("default_model = ?"); values.push(updates.defaultModel); }
    if (updates.defaultThinkingLevel !== undefined) { sets.push("default_thinking_level = ?"); values.push(updates.defaultThinkingLevel); }
    if (updates.allowedTools !== undefined) { sets.push("allowed_tools = ?"); values.push(JSON.stringify(updates.allowedTools)); }
    if (updates.workspacePath !== undefined) { sets.push("workspace_path = ?"); values.push(toStoredWorkspacePath(updates.workspacePath)); }
    if (updates.ownerId !== undefined) { sets.push("owner_id = ?"); values.push(updates.ownerId ?? null); }
    if (updates.isGlobal !== undefined) { sets.push("is_global = ?"); values.push(updates.isGlobal ? 1 : 0); }

    if (sets.length === 0) return;
    sets.push("updated_at = NOW()");
    values.push(id);

    await db.execute(
      `UPDATE agents SET ${sets.join(", ")} WHERE id = ?`,
      values,
    );
  },

  async delete(id: string): Promise<void> {
    await db.execute("DELETE FROM agents WHERE id = ?", [id]);
  },

  async deleteAll(): Promise<void> {
    await db.execute("DELETE FROM agents");
  },

  toConfig(a: StoredAgent): AgentConfig {
    return {
      id: a.id,
      name: a.name,
      description: a.description,
      defaultProvider: a.defaultProvider,
      defaultModel: a.defaultModel,
      defaultThinkingLevel: a.defaultThinkingLevel,
      allowedTools: a.allowedTools,
      systemPrompt: undefined, // read from workspace agent.md
      workspacePath: a.workspacePath,
      createdAt: a.createdAt,
      updatedAt: a.updatedAt,
    };
  },
};
