#!/usr/bin/env tsx
/**
 * Interactive CLI debug tool — connects directly to the Pi SDK (no HTTP server).
 *
 * Usage:
 *   npm run cli                     # interactive mode (default agent from args)
 *   npm run cli -- --agent demo-agent
 *   npm run cli -- --agent test-agent --model gpt-4o
 *   npm run cli -- --one "hello"    # one-shot, then exit
 *
 * Commands in interactive mode:
 *   /help              — show commands
 *   /agent <id>        — switch agent
 *   /model <model>     — switch model
 *   /provider <name>   — switch provider
 *   /new               — start a new session
 *   /info              — show current agent/model/session
 *   /exit              — quit
 */

import { createInterface } from "node:readline";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "../src/config.js";
import { db } from "../src/db.js";
import { modelService } from "../src/services/model.service.js";
import { agentService } from "../src/services/agent.service.js";
import { chatService } from "../src/services/chat.service.js";
import { userRepository } from "../src/repositories/user.repository.js";
import bcrypt from "bcryptjs";
import { randomUUID } from "node:crypto";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

// ── ANSI colors ──────────────────────────────────────────────────────────────
const C = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
  red: "\x1b[31m",
  magenta: "\x1b[35m",
  bold: "\x1b[1m",
  grey: "\x1b[90m",
  blue: "\x1b[34m",
};

function log(type: string, ...args: unknown[]) {
  const label = `[${type}]`;
  switch (type) {
    case "system":   console.log(`${C.dim}${label}${C.reset}`, ...args); break;
    case "send":     console.log(`\n${C.bold}${C.magenta}>>>${C.reset}`, ...args); break;
    case "text":     console.log(`${C.green}${args.join(" ")}${C.reset}`); break;
    case "thinking": console.log(`${C.dim}${C.yellow}${args.join("")}${C.reset}`); break;
    case "tool":     console.log(`  ${C.cyan}◆ ${args[0]}${C.reset} ${C.dim}${args.slice(1).join(" ")}${C.reset}`); break;
    case "tool-ok":  console.log(`  ${C.green}✓ ${args[0]}${C.reset} ${C.dim}(done)${C.reset}`); break;
    case "tool-err": console.log(`  ${C.red}✗ ${args[0]}${C.reset} ${C.dim}(error)${C.reset}`); break;
    case "tool-upd": console.log(`  ${C.blue}◈ ${args[0]}${C.reset} ${C.dim}${args.slice(1).join(" ")}${C.reset}`); break;
    case "error":    console.error(`${C.red}${C.bold}ERROR${C.reset}`, ...args); break;
    case "reply":    console.log(`\n${C.bold}${C.green}── Reply ──${C.reset}`); break;
    case "lifecycle": console.log(`  ${C.dim}${C.grey}${args.join("")}${C.reset}`); break;
    default:         console.log(label, ...args);
  }
}

// ── CLI state ────────────────────────────────────────────────────────────────

interface CliState {
  userId: string;
  agentId: string;
  provider: string;
  modelId: string;
  sessionId?: string;
}

function parseArgs(): { agentId: string; provider: string; modelId: string; oneShot?: string } {
  const argv = process.argv.slice(2);
  const get = (flag: string) => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  return {
    agentId: get("--agent") || "demo-agent",
    provider: get("--provider") || config.defaultProvider,
    modelId: get("--model") || config.defaultModel,
    oneShot: get("--one"),
  };
}

// ── Agent chat helper ────────────────────────────────────────────────────────

async function chatOnce(
  state: CliState,
  message: string,
  onEvent?: (type: string, data: any) => void,
): Promise<string | null> {
  let fullText = "";
  let fullThinking = "";
  let inThinking = false;
  let inTurn = false;
  const ac = new AbortController();

  const defaultOnEvent = (type: string, data: any) => {
    switch (type) {
      case "agent_start":
        console.log(`\n${C.dim}${C.grey}┌─ Agent start ──────────────────────${C.reset}`);
        break;

      case "agent_end":
        if (inThinking) {
          console.log(); // close thinking line
        }
        console.log(`${C.dim}${C.grey}└─ Agent end (messages: ${data.messageCount}) ─${C.reset}`);
        break;

      case "turn_start":
        inTurn = true;
        console.log(`${C.dim}${C.grey}  ├─ Turn start${C.reset}`);
        break;

      case "turn_end": {
        inTurn = false;
        const reason = data.stopReason ? ` stopReason=${data.stopReason}` : "";
        console.log(`${C.dim}${C.grey}  ├─ Turn end${reason}${C.reset}`);
        break;
      }

      case "message_start":
        console.log(`${C.dim}${C.grey}  │  message${C.reset}`);
        break;

      case "text_delta":
        if (inThinking) {
          // Transition from thinking to text — print the divider
          inThinking = false;
          console.log(); // close thinking line
          console.log(`  ${C.bold}${C.green}── Response ──${C.reset}`);
          process.stdout.write(C.green);
        }
        process.stdout.write(data.delta + C.reset);
        if (inTurn) process.stdout.write(C.green); // keep green if still in turn
        fullText += data.delta;
        break;

      case "thinking_delta":
        if (!inThinking) {
          inThinking = true;
          console.log(`  ${C.bold}${C.yellow}── Thinking ──${C.reset}`);
          process.stdout.write(C.dim + C.yellow);
        }
        process.stdout.write(data.delta + C.reset);
        if (inThinking) process.stdout.write(C.dim + C.yellow);
        fullThinking += data.delta;
        break;

      case "message_update":
        // Full accumulated message snapshot — only log if there's thinking content
        if (data.message?.content?.thinking && !inThinking) {
          // Thinking already finished; log any remaining thinking we might have missed
        }
        break;

      case "tool_execution_start":
        console.log(`  ${C.cyan}◆ ${data.toolName}${C.reset} ${C.dim}${JSON.stringify(data.args).slice(0, 150)}${C.reset}`);
        break;

      case "tool_execution_update":
        log("tool-upd", data.toolName, data.output ? JSON.stringify(data.output).slice(0, 100) : "(no output)");
        break;

      case "tool_execution_end":
        if (data.isError) log("tool-err", data.toolName);
        else log("tool-ok", data.toolName);
        break;

      case "error":
        log("error", data.error);
        break;
    }
  };

  const eventHandler = onEvent || defaultOnEvent;

  await chatService.streamMessage(
    state.userId, state.agentId,
    { message, provider: state.provider, model: state.modelId, sessionId: state.sessionId },
    eventHandler,
    ac.signal,
  );

  // Close any open ANSI styles
  process.stdout.write(C.reset);

  return fullText || null;
}

// ── Interactive loop ─────────────────────────────────────────────────────────

async function interactive(state: CliState) {
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });

  log("system", `Agent: ${C.bold}${state.agentId}${C.reset}`);
  log("system", `Model: ${C.bold}${state.provider}/${state.modelId}${C.reset}`);
  log("system", `Type a message or /help for commands.\n`);

  const promptUser = (): Promise<string> => new Promise((resolve) => rl.question(`${C.cyan}You>${C.reset} `, resolve));

  let input = await promptUser();

  while (input !== "/exit" && input !== "/quit") {
    // ── Handle commands ──────────────────────────────────────────────────────
    if (input.startsWith("/")) {
      const parts = input.slice(1).split(/\s+/);
      const cmd = parts[0];
      const arg = parts.slice(1).join(" ");

      switch (cmd) {
        case "help":
          console.log(`
  ${C.bold}Commands${C.reset}
    /agent <id>       — switch agent
    /model <model>    — switch model
    /provider <name>  — switch provider
    /new              — start a new session
    /info             — show current settings
    /exit, /quit      — exit
          `);
          break;
        case "agent":
          if (!arg) { log("error", "Usage: /agent <agent-id>"); break; }
          state.agentId = arg;
          state.sessionId = undefined;
          log("system", `Switched to agent: ${C.bold}${arg}${C.reset}`);
          break;
        case "model":
          if (!arg) { log("error", "Usage: /model <model-id>"); break; }
          state.modelId = arg;
          state.sessionId = undefined;
          log("system", `Switched to model: ${C.bold}${arg}${C.reset}`);
          break;
        case "provider":
          if (!arg) { log("error", "Usage: /provider <name>"); break; }
          state.provider = arg;
          state.sessionId = undefined;
          log("system", `Switched to provider: ${C.bold}${arg}${C.reset}`);
          break;
        case "new":
          state.sessionId = await chatService.newSession(state.userId, state.agentId);
          log("system", `New session: ${C.bold}${state.sessionId}${C.reset}`);
          break;
        case "info":
          console.log(`  Agent:    ${C.bold}${state.agentId}${C.reset}`);
          console.log(`  Provider: ${C.bold}${state.provider}${C.reset}`);
          console.log(`  Model:    ${C.bold}${state.modelId}${C.reset}`);
          console.log(`  Session:  ${state.sessionId || "(new)"}`);
          break;
        default:
          log("error", `Unknown command: ${cmd}. Type /help`);
      }

      input = await promptUser();
      continue;
    }

    // ── Send message ────────────────────────────────────────────────────────
    log("send", input);

    try {
      const result = await chatOnce(state, input);
      if (result) {
        console.log("\n");
      } else {
        log("error", "No response received.");
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      log("error", msg);
    }

    input = await promptUser();
  }

  log("system", "Bye!");
  rl.close();
  process.exit(0);
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs();

  // Initialize services (same as server startup)
  await db.init();

  // The sessions table FKs user_id to users.id (UUID), so the CLI needs a
  // real user row; resolve (or lazily create) the well-known "cli-user".
  let cliUser = await userRepository.findByUsername("cli-user");
  if (!cliUser) {
    cliUser = await userRepository.create({
      id: randomUUID(),
      username: "cli-user",
      passwordHash: await bcrypt.hash(randomUUID(), 10),
      displayName: "CLI Debug User",
      createdAt: new Date().toISOString(),
    });
    log("system", "Created users row for cli-user");
  }

  await modelService.init(config.agentDir);
  await agentService.init();
  await chatService.init();

  // Auto-register provider from .env
  if (config.providerApiKey && config.providerBaseUrl) {
    await modelService.registerProvider({
      name: config.providerName || config.defaultProvider,
      baseUrl: config.providerBaseUrl,
      apiKey: config.providerApiKey,
      models: [
        {
          id: config.defaultModel,
          name: config.defaultModel,
          contextWindow: 128000,
          maxTokens: 4096,
        },
      ],
    });
    log("system", `Provider "${config.providerName || config.defaultProvider}" registered`);
  }

  // Agents are loaded from agents.json only; no auto-creation.

  const state: CliState = {
    userId: cliUser.id,
    agentId: args.agentId,
    provider: args.provider,
    modelId: args.modelId,
  };

  // One-shot mode
  if (args.oneShot) {
    log("system", `One-shot: agent=${state.agentId} model=${state.provider}/${state.modelId}\n`);
    const result = await chatOnce(state, args.oneShot);
    if (result) console.log("\n");
    await db.close();
    process.exit(0);
  }

  // Interactive mode
  await interactive(state);
  await db.close();
  process.exit(0);
}

main().catch((e) => {
  log("error", e instanceof Error ? e.message : String(e));
  process.exit(1);
});
