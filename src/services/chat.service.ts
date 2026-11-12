import { randomUUID } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import {
  createAgentSession,
  DefaultResourceLoader,
  loadSkillsFromDir,
  SessionManager,
  type AgentSession,
} from "@earendil-works/pi-coding-agent";
import { modelService } from "./model.service.js";
import { agentService } from "./agent.service.js";
import { assertMessageSafe } from "./chat-safety.js";
import { config } from "../config.js";
import { sessionRepository } from "../repositories/session.repository.js";
import { SessionCache } from "./session-cache.js";
import { llmGate } from "./llm-gate.js";
import type { AgentConfig, ChatRequest, ChatResponse } from "../types.js";
import { extractUsage, isContextLimitReached, contextLimitMessage } from "./usage.service.js";
import { createLogger } from "../logger.js";
const log = createLogger("chat");

interface ActiveSession {
  session: AgentSession;
  sessionId: string;
  agentId: string;
  createdAt: number;
}

class ChatService {
  /**
   * Bounded cache of live Pi sessions (TTL + LRU + capacity, see
   * `src/services/session-cache.ts`). Sessions evicted here are not lost:
   * state is persisted to MySQL and transparently rebuilt on the next
   * message (see getOrCreateSession).
   */
  private sessions = new SessionCache<ActiveSession>({
    ttlMs: config.sessionIdleTtlMs,
    capacity: config.sessionCacheCapacity,
    dispose: (active) => {
      try {
        active.session.dispose();
      } catch (e) {
        log.warn("session dispose failed", e instanceof Error ? e.message : String(e));
      }
    },
  });
  private sweeper: NodeJS.Timeout | null = null;

  async init(): Promise<void> {
    // Clear in-memory sessions on restart (persistent state is in MySQL)
    this.dispose();
    if (!this.sweeper && config.sessionSweepIntervalMs > 0) {
      this.sweeper = setInterval(() => {
        const before = this.sessions.size;
        this.sessions.sweep();
        if (this.sessions.size !== before) {
          log.info(`session cache sweep: ${before} -> ${this.sessions.size} (Evicted sessions idle > ${Math.round(config.sessionIdleTtlMs / 60000)}min)`);
        }
      }, config.sessionSweepIntervalMs);
      // Never keep the process alive just for the sweeper.
      this.sweeper.unref();
    }
  }

  // ── Resource loader ─────────────────────────────────────────────────

  private async buildLoader(agent: AgentConfig): Promise<DefaultResourceLoader> {
    const skillsDir = resolve(agent.workspacePath, "skills");

    const loader = new DefaultResourceLoader({
      cwd: agent.workspacePath,
      agentDir: config.agentDir,

      systemPromptOverride: () => {
        const mdPath = resolve(agent.workspacePath, "agent.md");
        if (!existsSync(mdPath)) return undefined;
        return readFileSync(mdPath, "utf-8");
      },

      skillsOverride: (base) => {
        if (!existsSync(skillsDir)) return base;
        const custom = loadSkillsFromDir({ dir: skillsDir, source: "workspace" });
        return {
          skills: [...base.skills, ...custom.skills],
          diagnostics: [...base.diagnostics, ...custom.diagnostics],
        };
      },
    });

    await loader.reload();
    return loader;
  }

  // ── Session resolver (shared) ───────────────────────────────────────

  private async getOrCreateSession(
    userId: string, agentId: string, req: ChatRequest,
  ): Promise<{ session: AgentSession; sessionId: string; agentConfig: AgentConfig; provider: string; modelId: string; model: any }> {
    const agentConfig = await agentService.get(agentId);
    if (!agentConfig) throw new Error(`Agent not found: ${agentId}`);

    const provider = req.provider || agentConfig.defaultProvider || config.defaultProvider;
    const modelId = req.model || agentConfig.defaultModel || config.defaultModel;

    // MySQL provider config (base_url, api_key) takes precedence; .env is fallback.
    const model = await modelService.resolveModel(provider, modelId);
    if (!model) {
      throw new Error(`Model ${provider}/${modelId} not found. Register a provider first.`);
    }

    let sessionId = req.sessionId;
    let active = sessionId ? this.getActive(userId, agentId, sessionId) : undefined;

    if (!active) {
      // Ownership check: a client-supplied sessionId that belongs to another
      // user/agent must not be adopted by the upsert nor have its messages loaded.
      if (req.sessionId) {
        const existing = await sessionRepository.findById(sessionId!);
        if (existing && (existing.userId !== userId || existing.agentId !== agentId)) {
          throw new Error("Session not found");
        }
      }
      sessionId = sessionId || await sessionRepository.getCurrentSessionId(userId, agentId) || randomUUID();
      await sessionRepository.ensureSession(sessionId, userId, agentId);
      const savedMessages = await sessionRepository.loadMessages(sessionId);
      const loader = await this.buildLoader(agentConfig);

      const result = await createAgentSession({
        cwd: agentConfig.workspacePath,
        model,
        thinkingLevel: req.thinkingLevel ?? agentConfig.defaultThinkingLevel ?? "off",
        modelRuntime: modelService.modelRuntime,
        sessionManager: SessionManager.inMemory(),
        tools: agentConfig.allowedTools as any,
        resourceLoader: loader,
      });

      if (savedMessages.length > 0) {
        result.session.agent.state.messages = savedMessages;
      }

      active = { session: result.session as unknown as AgentSession, sessionId, agentId, createdAt: Date.now() };
      this.sessions.set(this.key(userId, agentId, sessionId), active);
      await sessionRepository.touch(sessionId);
    }

    if (active.session.model?.id !== model.id) {
      await active.session.setModel(model);
    }

    return { session: active.session, sessionId: active.sessionId, agentConfig, provider, modelId, model };
  }

  // ── Send message (non‑streaming) ────────────────────────────────────

  async sendMessage(
    userId: string, agentId: string, req: ChatRequest,
  ): Promise<ChatResponse & { sessionId: string }> {
    assertMessageSafe(req.message);
    const { session, sessionId, provider, modelId } = await this.getOrCreateSession(userId, agentId, req);
    await this.checkContextLimit(session, sessionId);
    await this.maybeSetSessionTitle(sessionId, req.message);
    // Bound concurrent LLM calls: extra requests queue (up to
    // config.llmQueueTimeoutMs) instead of multiplying peak memory.
    await llmGate.acquire();
    try {
      const reply = await this.collectResponse(session, req.message);
      await sessionRepository.saveMessages(sessionId, session.agent.state.messages);
      await this.recordUsage(session, sessionId);
      const usageData = extractUsage(session);
      return { agentId, sessionId, reply, model: { provider, model: modelId }, usage: usageData?.usage };
    } finally {
      llmGate.release();
    }
  }

  // ── Streaming message (SSE) ─────────────────────────────────────────

  async streamMessage(
    userId: string, agentId: string, req: ChatRequest,
    onEvent: (type: string, data: any) => void,
    abortSignal?: AbortSignal,
  ): Promise<{ sessionId: string; model: { provider: string; model: string }; reply: string }> {
    assertMessageSafe(req.message);
    const { session, sessionId, agentConfig, provider, modelId, model } = await this.getOrCreateSession(userId, agentId, req);
    await this.checkContextLimit(session, sessionId);
    await this.maybeSetSessionTitle(sessionId, req.message);

    if (abortSignal) {
      abortSignal.addEventListener("abort", () => { session.abort(); }, { once: true });
    }

    const textChunks: string[] = [];

    const unsub = session.subscribe((event: any) => {
      log.debug(`stream-event type=${event.type} keys=${Object.keys(event).join(",")}`);
      switch (event.type) {
        case "agent_start":
          onEvent("agent_start", {});
          break;
        case "agent_end":
          onEvent("agent_end", { messageCount: event.messages?.length });
          break;
        case "turn_start":
          onEvent("turn_start", {});
          break;
        case "turn_end":
          onEvent("turn_end", {
            toolResultCount: event.toolResults?.length ?? 0,
            stopReason: event.message?.stopReason,
            error: event.message?.errorMessage || (event.message?.error ? String(event.message.error) : undefined),
          });
          break;
        case "message_update": {
          const ev = event.assistantMessageEvent;
          if (ev?.type === "text_delta") {
            textChunks.push(ev.delta);
            onEvent("text_delta", { delta: ev.delta });
          } else if (ev?.type === "thinking_delta") {
            onEvent("thinking_delta", { delta: ev.delta });
          }
          break;
        }
        case "tool_execution_start":
          onEvent("tool_execution_start", {
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            args: event.args,
          });
          break;
        case "tool_execution_update":
          onEvent("tool_execution_update", {
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            partialResult: event.partialResult,
          });
          break;
        case "tool_execution_end":
          onEvent("tool_execution_end", {
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            isError: event.isError,
          });
          break;
      }
    });

    let promptErr: any = null;
    // Same concurrency gate as the non-streaming path.
    await llmGate.acquire();
    try {
      try {
        await withRetry(() => session.prompt(req.message));
      } catch (e) {
        promptErr = e;
        const state = session.agent?.state;
        log.error("session.prompt failed", {
          err: promptErr instanceof Error ? promptErr.message : String(promptErr),
          provider: model?.provider ?? provider,
          model: model?.id ?? modelId,
          thinkingLevel: req.thinkingLevel ?? agentConfig.defaultThinkingLevel ?? "off",
          messageCount: state?.messages?.length,
          toolCount: (agentConfig.allowedTools as any[])?.length,
        });
      }
    } finally {
      llmGate.release();
      unsub();
    }

    // Always persist messages and usage, even when the prompt threw.
    // The agent state may contain partial output that is still valuable.
    const msgs = session.agent.state.messages;
    const last = msgs[msgs.length - 1] as any;
    const stopReason = last?.stopReason;
    log.debug(`stream: after prompt: ${msgs.length} messages, last role=${last?.role} stopReason=${stopReason} contentLen=${typeof last?.content === "string" ? last.content.length : last?.content?.length ?? "non-string"}`);

    await sessionRepository.saveMessages(sessionId, msgs);
    await this.recordUsage(session, sessionId);

    // If the prompt threw, report the error after persistence so the client
    // sees it but messages/usage are not lost.
    if (promptErr) {
      const errReply = this.extractReply(msgs, textChunks) || (promptErr instanceof Error ? promptErr.message : String(promptErr));
      log.warn(`stream: agent ${agentId} session ${sessionId} finished with error, replyLen=${errReply.length}`);
      onEvent("error", { error: errReply });
      // Return a result so the route handler sends "done" — the client already
      // received the "error" event above.
      return { sessionId, model: { provider, model: modelId }, reply: errReply };
    }

    const reply = this.extractReply(msgs, textChunks) || (stopReason === "error" ? this.extractErrorMessage(last) : "");

    if (stopReason === "aborted" || stopReason === "error") {
      log.warn(`stream: agent ${agentId} session ${sessionId} finished with stopReason=${stopReason}, replyLen=${reply.length}`);
      if (stopReason === "error" && reply) {
        onEvent("error", { error: reply });
      }
    }

    return { sessionId, model: { provider, model: modelId }, reply };
  }

  private extractReply(messages: any[], textChunks?: string[]): string {
    const lastAssistant = [...messages].reverse().find((m: any) => m?.role === "assistant");
    const c = lastAssistant?.content;
    if (typeof c === "string" && c.length > 0) return c;
    if (Array.isArray(c)) {
      const joined = c.filter((b: any) => b?.type === "text").map((b: any) => b.text ?? "").join("");
      if (joined.length > 0) return joined;
    }
    if (textChunks && textChunks.length > 0) {
      return textChunks.join("");
    }
    return "";
  }

  private extractErrorMessage(message: any): string {
    if (!message) return "";
    if (typeof message.errorMessage === "string" && message.errorMessage.length > 0) {
      return message.errorMessage;
    }
    if (message.error) {
      return typeof message.error === "string" ? message.error : JSON.stringify(message.error);
    }
    return "";
  }

  /** The first user message becomes the session title shown in session lists. */
  private async maybeSetSessionTitle(sessionId: string, message: string): Promise<void> {
    const title = message.replace(/\s+/g, " ").trim().slice(0, 100);
    if (title) await sessionRepository.setTitleIfEmpty(sessionId, title);
  }

  // ── Session listing & management ────────────────────────────────────

  /** List sessions owned by a user across all agents, newest first */
  async listSessions(userId: string): Promise<{ userId: string; agentId: string; sessionId: string; title: string | null; createdAt: string; updatedAt: string; messageCount: number }[]> {
    const records = await sessionRepository.listByUser(userId);
    return Promise.all(
      records.map(async (r) => ({
        userId: r.userId,
        agentId: r.agentId,
        sessionId: r.sessionId,
        title: r.title,
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
        messageCount: await sessionRepository.countMessages(r.sessionId),
        usage: r.usage,
        contextUsage: r.contextUsage,
      })),
    );
  }

  /** List sessions for a specific agent, newest first */
  async listAgentSessions(userId: string, agentId: string): Promise<{ sessionId: string; title: string | null; createdAt: string; updatedAt: string; messageCount: number }[]> {
    const records = await sessionRepository.findByUserAndAgent(userId, agentId);
    return Promise.all(
      records.map(async (r) => ({
        sessionId: r.sessionId,
        title: r.title,
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
        messageCount: await sessionRepository.countMessages(r.sessionId),
        usage: r.usage,
        contextUsage: r.contextUsage,
      })),
    );
  }

  async getSessionMessages(userId: string, agentId: string, sessionId: string): Promise<{ role: string; content: string }[]> {
    const session = await sessionRepository.findByUserAndAgent(userId, agentId);
    if (!session.find((r) => r.sessionId === sessionId)) {
      return []; // session not found or not owned by this user+agent
    }
    return sessionRepository.getSessionMessages(sessionId);
  }

  async newSession(userId: string, agentId: string): Promise<string> {
    // Full UUID: the sessions.session_id column is VARCHAR(36); the 12-char
    // truncation only reduced entropy (and looked odd in error logs).
    const sessionId = randomUUID();
    await sessionRepository.ensureSession(sessionId, userId, agentId);
    // Remove any in-memory session for the old current sessionId
    const oldId = await sessionRepository.getCurrentSessionId(userId, agentId);
    if (oldId && oldId !== sessionId) {
      const oldKey = this.key(userId, agentId, oldId);
      this.sessions.delete(oldKey);
    }
    return sessionId;
  }

  async resetSession(userId: string, agentId: string, sessionId?: string): Promise<{ deleted: boolean; sessionsDeleted: number }> {
    if (sessionId) {
      const key = this.key(userId, agentId, sessionId);
      const active = this.sessions.get(key);
      if (active) {
        active.session.dispose();
        this.sessions.delete(key);
      }
      // Only the owner (same user + agent) may delete a session.
      const record = await sessionRepository.findById(sessionId);
      if (record && record.userId === userId && record.agentId === agentId) {
        await sessionRepository.deleteSession(sessionId);
        return { deleted: true, sessionsDeleted: 1 };
      }
      return { deleted: false, sessionsDeleted: 0 };
    } else {
      const prefix = `${userId}:${agentId}:`;
      this.sessions.deleteWhere((key) => key.startsWith(prefix));
      const deleted = await sessionRepository.deleteByUserAndAgent(userId, agentId);
      return { deleted: deleted > 0, sessionsDeleted: deleted };
    }
  }

  async resumeSession(userId: string, agentId: string, sessionId: string): Promise<boolean> {
    const records = await sessionRepository.findByUserAndAgent(userId, agentId);
    if (!records.find((r) => r.sessionId === sessionId)) return false;
    await sessionRepository.touch(sessionId);
    return true;
  }

  dispose(): void {
    if (this.sweeper) {
      clearInterval(this.sweeper);
      this.sweeper = null;
    }
    this.sessions.disposeAll();
  }

  /** Runtime introspection for /api/health: live session + gate pressure. */
  stats(): {
    sessions: { size: number; capacity: number; ttlMs: number; evictedIdle: number; evictedOther: number };
    llmGate: { limit: number; active: number; waiting: number; totalRejected: number };
  } {
    return { sessions: this.sessions.stats(), llmGate: llmGate.stats() };
  }



  /** Persist token usage from the SDK after a prompt completes. */
  private async recordUsage(session: any, sessionId: string): Promise<void> {
    const usageData = extractUsage(session);
    if (!usageData) return;
    await sessionRepository.updateUsage(sessionId, usageData.usage, usageData.contextUsage);
  }

  /** Reject further prompts when the SDK reports the context window is full. */
  private async checkContextLimit(session: any, sessionId: string): Promise<void> {
    const ctx = session.getContextUsage?.();
    if (ctx && isContextLimitReached(ctx)) {
      throw new Error(contextLimitMessage(ctx));
    }
    // Fallback: if the SDK hasn't computed context usage yet, respect any
    // persisted limit from a previous turn.
    if (!ctx) {
      const record = await sessionRepository.findById(sessionId);
      if (record?.contextUsage && isContextLimitReached(record.contextUsage)) {
        throw new Error(contextLimitMessage(record.contextUsage));
      }
    }
  }

  // ── Internals ───────────────────────────────────────────────────────

  private key(userId: string, agentId: string, sessionId: string): string {
    return `${userId}:${agentId}:${sessionId}`;
  }

  private getActive(userId: string, agentId: string, sessionId: string): ActiveSession | undefined {
    // SessionCache.get refreshes the TTL/LRU position on access.
    return this.sessions.get(this.key(userId, agentId, sessionId));
  }

  // ── Stream collector ────────────────────────────────────────────────

  private async collectResponse(session: any, message: string): Promise<string> {
    const chunks: string[] = [];
    const unsub = session.subscribe((event: any) => {
      if (event.type === "message_update" && event.assistantMessageEvent?.type === "text_delta") {
        chunks.push(event.assistantMessageEvent.delta);
      }
    });
    try {
      await withRetry(() => session.prompt(message));
    } finally {
      unsub();
    }
    if (!chunks.length) {
      const msgs = session.agent?.state?.messages ?? [];
      const last = msgs[msgs.length - 1];
      if (last?.stopReason === "error" || last?.stopReason === "aborted") {
        const errorMsg = this.extractErrorMessage(last);
        log.warn("prompt completed with error:", errorMsg || last.stopReason);
        return errorMsg || `[${last.stopReason}]`;
      }
    }
    return chunks.join("");
  }
}

async function withRetry<T>(fn: () => Promise<T>, maxRetries = 5, delayMs = 1000): Promise<T> {
  let lastError: any;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (e: any) {
      lastError = e;
      const is429 =
        e?.message?.includes("429") ||
        e?.message?.includes("Too Many Requests") ||
        e?.message?.includes("rate_limit") ||
        e?.status === 429 ||
        e?.statusCode === 429;
      if (!is429 || attempt === maxRetries) throw e;
      const wait = delayMs * attempt;
      log.warn(`429 rate limited (attempt ${attempt}/${maxRetries}), retrying in ${wait}ms...`);
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
  }
  throw lastError;
}

export const chatService = new ChatService();
