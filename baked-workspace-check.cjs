/**
 * Build-time integrity guard for pre-baked agent workspaces (see Dockerfile).
 *
 * Verifies that:
 *  1. every workspace under /app/.workplaces-baked has agent.md, and any
 *     skills/ subdirectory has a SKILL.md, and any wiki/ has index.md;
 *  2. every agent referenced by /app/agents.json has a matching baked
 *     workspace (so a newly added agent can never silently fail to ship).
 *
 * Exits non-zero on any violation, failing the docker build.
 */
"use strict";
const fs = require("fs");
const path = require("path");

const baked = "/app/.workplaces-baked";
const agentsFile = "/app/agents.json";

function fail(msg) {
  console.error("[build] " + msg);
  process.exit(1);
}

function containsWorkspaceContent(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === ".gitkeep" || entry.name === ".env.template") continue;
    if (entry.isDirectory()) {
      if (containsWorkspaceContent(path.join(dir, entry.name))) return true;
    } else {
      return true;
    }
  }
  return false;
}

const wsDirs = fs
  .readdirSync(baked)
  .filter((d) => {
    const dir = path.join(baked, d);
    return fs.statSync(dir).isDirectory() && containsWorkspaceContent(dir);
  });

for (const d of wsDirs) {
  const ws = path.join(baked, d);
  const agentMd = path.join(ws, "agent.md");
  if (!fs.existsSync(agentMd)) fail(`MISSING ${agentMd}`);

  const skills = path.join(ws, "skills");
  if (fs.existsSync(skills)) {
    for (const s of fs.readdirSync(skills)) {
      const skillMd = path.join(skills, s, "SKILL.md");
      if (!fs.existsSync(skillMd)) fail(`MISSING ${skillMd}`);
    }
  }

  const wiki = path.join(ws, "wiki");
  if (fs.existsSync(wiki) && !fs.existsSync(path.join(wiki, "index.md"))) {
    fail(`MISSING ${path.join(wiki, "index.md")}`);
  }
}

const agents = JSON.parse(fs.readFileSync(agentsFile, "utf8"));
for (const a of agents) {
  const ws = path.join(baked, a.workspacePath || a.id);
  if (!fs.existsSync(path.join(ws, "agent.md"))) {
    fail(`agents.json references missing baked workspace: ${a.id} -> ${ws}`);
  }
}

console.log("[build] baked workspace integrity OK");
