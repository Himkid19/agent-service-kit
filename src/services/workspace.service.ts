import { mkdir, writeFile, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { config } from "../config.js";

/** Resolve workspace root from live config so tests can override */
function workspaceRoot(): string {
  return config.workplacesDir;
}

// --- Workspace path portability -------------------------------------------
// workspacePath is persisted in a MySQL database that may be shared between
// machines (e.g. local Windows dev + CentOS server). Absolute paths leak the
// writer's filesystem layout into the shared DB and break the other machine.
// Therefore paths are STORED relative to workplacesDir (forward slashes) and
// RESOLVED back to a local absolute path on read. Legacy absolute values
// (written before this change) are still understood: a path under the local
// workplacesDir is used as-is; a foreign absolute path falls back to its
// directory name under the local workplacesDir.

function normalizeSep(p: string): string {
  return p.replace(/\\/g, "/");
}

function workplacesRootNormalized(): string {
  return normalizeSep(resolve(workspaceRoot())).replace(/\/+$/, "") + "/";
}

/** True for both POSIX-rooted ("/app/...") and Windows ("C:\..." / "\...") paths. */
function looksAbsolute(p: string): boolean {
  return /^([A-Za-z]:[\\/]|[\\/])/.test(p);
}

function baseName(p: string): string {
  const parts = normalizeSep(p).split("/").filter(Boolean);
  return parts[parts.length - 1] ?? p;
}

/** Convert a persisted workspacePath into an absolute path on this machine. */
export function toLocalWorkspacePath(stored: string): string {
  if (!looksAbsolute(stored)) return resolve(workspaceRoot(), stored);
  if (normalizeSep(stored).startsWith(workplacesRootNormalized())) return stored;
  // Foreign absolute path written by another machine: use its dir name locally.
  return resolve(workspaceRoot(), baseName(stored));
}

/** Convert a workspacePath into the portable relative form for persistence. */
export function toStoredWorkspacePath(p: string): string {
  if (!looksAbsolute(p)) return normalizeSep(p);
  const root = workplacesRootNormalized();
  const norm = normalizeSep(p);
  if (norm.startsWith(root)) return norm.slice(root.length);
  return baseName(p);
}

/** Default agent.md for new agents */
const DEFAULT_AGENT_MD = `# Agent Instructions

You are a helpful AI assistant. Follow these guidelines:

1. Be concise and accurate
2. Use available tools when needed
3. Admit when you don't know something
4. Think step by step for complex problems

## Tools

Available tools are configured per agent.

## Skills

Skills are loaded from the \`skills/\` directory.
`;

export interface WorkspaceInit {
  agentId: string;
  name: string;
}

export interface WorkspaceInfo {
  path: string;
  agentId: string;
  hasAgentMd: boolean;
  fileCount: number;
}

class WorkspaceManager {
  private workspaces = new Map<string, WorkspaceInfo>();

  async init(): Promise<void> {
    await mkdir(workspaceRoot(), { recursive: true });
  }

  /** Create a new workspace directory with default files */
  async create(opts: WorkspaceInit): Promise<string> {
    const wsPath = resolve(workspaceRoot(), opts.agentId);

    if (existsSync(wsPath)) {
      throw new Error(`Workspace already exists for agent: ${opts.agentId}`);
    }

    await mkdir(wsPath, { recursive: true });
    await mkdir(resolve(wsPath, "skills"), { recursive: true });
    await mkdir(resolve(wsPath, "reference"), { recursive: true });

    // Write default agent.md
    await writeFile(resolve(wsPath, "agent.md"), DEFAULT_AGENT_MD, "utf-8");

    const info: WorkspaceInfo = {
      path: wsPath,
      agentId: opts.agentId,
      hasAgentMd: true,
      fileCount: 1,
    };
    this.workspaces.set(opts.agentId, info);
    return wsPath;
  }

  /** Get workspace information */
  get(agentId: string): WorkspaceInfo | undefined {
    return this.workspaces.get(agentId);
  }

  /** Read the agent.md from workspace */
  async readAgentMd(agentId: string): Promise<string | null> {
    const ws = this.workspaces.get(agentId);
    if (!ws) return null;
    const mdPath = resolve(ws.path, "agent.md");
    if (!existsSync(mdPath)) return null;
    return readFile(mdPath, "utf-8");
  }

  /** Update agent.md */
  async writeAgentMd(agentId: string, content: string): Promise<void> {
    const ws = this.workspaces.get(agentId);
    if (!ws) throw new Error(`Workspace not found: ${agentId}`);
    await writeFile(resolve(ws.path, "agent.md"), content, "utf-8");
  }

  /** Load workspace from disk (on server restart) */
  async loadFromDisk(agentId: string): Promise<boolean> {
    const wsPath = resolve(workspaceRoot(), agentId);
    if (!existsSync(wsPath)) return false;

    const hasAgentMd = existsSync(resolve(wsPath, "agent.md"));
    const files = await this.countFiles(wsPath);

    this.workspaces.set(agentId, {
      path: wsPath,
      agentId,
      hasAgentMd,
      fileCount: files,
    });
    return true;
  }

  /** Remove a workspace from the in-memory registry (does not delete disk files) */
  remove(agentId: string): boolean {
    return this.workspaces.delete(agentId);
  }

  /** List all loaded workspaces */
  list(): WorkspaceInfo[] {
    return Array.from(this.workspaces.values());
  }

  private async countFiles(dir: string): Promise<number> {
    const { readdir } = await import("node:fs/promises");
    let count = 0;
    async function walk(d: string): Promise<void> {
      const entries = await readdir(d, { withFileTypes: true });
      for (const e of entries) {
        if (e.isDirectory()) await walk(resolve(d, e.name));
        else count++;
      }
    }
    await walk(dir);
    return count;
  }
}

export const workspaceManager = new WorkspaceManager();
