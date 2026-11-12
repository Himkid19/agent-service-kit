import { Router } from "express";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { existsSync } from "node:fs";
import { agentService } from "../services/agent.service.js";
import { workspaceManager } from "../services/workspace.service.js";
import { loadSkillsFromDir } from "@earendil-works/pi-coding-agent";
import { authRequired, type AuthenticatedRequest } from "../middleware/auth.js";

const router = Router();

// All agent routes require auth
router.use(authRequired);

/** List all agents (shared across all users) */
router.get("/", async (_req, res, next) => {
  try {
    const agents = await agentService.list();
    res.json({ agents });
  } catch (e) {
    next(e);
  }
});

/** Get agent detail */
router.get("/:id", async (req, res, next) => {
  try {
    const agent = await agentService.get(req.params.id);
    if (!agent) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }
    res.json(agent);
  } catch (e) {
    next(e);
  }
});

/** Create a new agent */
router.post("/", async (req: AuthenticatedRequest, res, next) => {
  try {
    const { name, description, allowedTools, defaultProvider, defaultModel, defaultThinkingLevel, systemPrompt } = req.body;
    if (!name) {
      res.status(400).json({ error: "name is required" });
      return;
    }
    const agent = await agentService.create({
      name,
      description: description || "",
      allowedTools,
      defaultProvider,
      defaultModel,
      defaultThinkingLevel,
      systemPrompt,
      ownerId: req.user!.sub,
    });
    res.status(201).json(agent);
  } catch (e) {
    next(e);
  }
});

/** Update agent config */
router.put("/:id", async (req: AuthenticatedRequest, res, next) => {
  try {
    const { name, description, allowedTools, defaultProvider, defaultModel, defaultThinkingLevel, systemPrompt } = req.body;
    const agent = await agentService.update(req.params.id, {
      name, description, allowedTools, defaultProvider, defaultModel, defaultThinkingLevel, systemPrompt,
    });
    res.json(agent);
  } catch (e) {
    next(e);
  }
});

/** Delete agent */
router.delete("/:id", async (req: AuthenticatedRequest, res, next) => {
  try {
    await agentService.delete(req.params.id);
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});

/** List skills for an agent */
router.get("/:id/skills", async (req: AuthenticatedRequest, res, next) => {
  try {
    const agent = await agentService.get(req.params.id);
    if (!agent) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }
    const skillsDir = resolve(agent.workspacePath, "skills");
    if (!existsSync(skillsDir)) {
      res.json({ skills: [] });
      return;
    }

    const loaded = loadSkillsFromDir({ dir: skillsDir, source: "workspace" });

    const skills = await Promise.all(
      loaded.skills.map(async (s) => {
        let content = "";
        try {
          content = await readFile(s.filePath, "utf-8");
        } catch { /* skill file not readable */ }
        return {
          name: s.name,
          file: s.filePath,
          description: s.description || "",
          content,
        };
      }),
    );

    res.json({ skills });
  } catch (e) {
    next(e);
  }
});

/** Read workspace agent.md */
router.get("/:id/workspace/agent.md", async (req: AuthenticatedRequest, res, next) => {
  try {
    const content = await workspaceManager.readAgentMd(req.params.id);
    if (content === null) {
      res.status(404).json({ error: "agent.md not found" });
      return;
    }
    res.json({ content });
  } catch (e) {
    next(e);
  }
});

/** Update workspace agent.md */
router.put("/:id/workspace/agent.md", async (req: AuthenticatedRequest, res, next) => {
  try {
    const { content } = req.body;
    if (!content) {
      res.status(400).json({ error: "content is required" });
      return;
    }
    await workspaceManager.writeAgentMd(req.params.id, content);
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});

export default router;
