import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { db } from "../src/db.js";
import { sessionRepository } from "../src/repositories/session.repository.js";
import { chatService } from "../src/services/chat.service.js";
import { extractUsage, isContextLimitReached, contextLimitMessage } from "../src/services/usage.service.js";
import { resetTables } from "./db-test-utils.js";

const userId = randomUUID();
const agentId = "agent-token-usage-test";

describe("session token usage", () => {
  const setup = async () => {
    await resetTables("messages", "sessions", "agents", "users");
    await db.execute(
      "INSERT INTO users (id, username, password_hash, display_name, created_at) VALUES (?, ?, ?, ?, NOW())",
      [userId, "token-user", "x", "Token User"],
    );
    await db.execute(
      `INSERT INTO agents (id, name, description, allowed_tools, workspace_path, is_global, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 0, NOW(), NOW())`,
      [agentId, agentId, "", "[]", agentId],
    );
  };

  it("repository stores and exposes usage fields", async () => {
    await setup();
    const sessionId = randomUUID();
    await sessionRepository.ensureSession(sessionId, userId, agentId);
    await sessionRepository.updateUsage(
      sessionId,
      { inputTokens: 10, outputTokens: 20, cacheReadTokens: 5, cacheWriteTokens: 1, totalTokens: 36, cost: 0.0001 },
      { tokens: 36, contextWindow: 128000, percent: 0.03 },
    );
    const record = await sessionRepository.findById(sessionId);
    expect(record?.usage).toEqual({ inputTokens: 10, outputTokens: 20, cacheReadTokens: 5, cacheWriteTokens: 1, totalTokens: 36, cost: 0.0001 });
    expect(record?.contextUsage).toEqual({ tokens: 36, contextWindow: 128000, percent: 0.03 });
  });

  it("chatService.listSessions surfaces usage from the repository", async () => {
    await setup();
    const sessionId = randomUUID();
    await sessionRepository.ensureSession(sessionId, userId, agentId);
    await sessionRepository.updateUsage(
      sessionId,
      { inputTokens: 1, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 3, cost: 0 },
      { tokens: 3, contextWindow: 4096, percent: 0.07 },
    );
    const sessions = await chatService.listSessions(userId);
    const s = sessions.find((x) => x.sessionId === sessionId);
    expect(s).toBeDefined();
    expect(s?.usage.totalTokens).toBe(3);
    expect(s?.contextUsage?.percent).toBe(0.07);
  });

  it("extractUsage converts SDK stats/contextUsage", () => {
    const session = {
      getSessionStats: () => ({
        tokens: { input: 100, output: 50, cacheRead: 10, cacheWrite: 5, total: 165 },
        cost: 0.0025,
      }),
      getContextUsage: () => ({ tokens: 165, contextWindow: 100000, percent: 0.17 }),
    };
    const got = extractUsage(session);
    expect(got?.usage).toEqual({ inputTokens: 100, outputTokens: 50, cacheReadTokens: 10, cacheWriteTokens: 5, totalTokens: 165, cost: 0.0025 });
    expect(got?.contextUsage).toEqual({ tokens: 165, contextWindow: 100000, percent: 0.17 });
  });

  it("extractUsage returns undefined when stats are unavailable", () => {
    expect(extractUsage({ getSessionStats: () => undefined, getContextUsage: () => undefined })).toBeUndefined();
  });

  it("isContextLimitReached is true at or above the configured limit", () => {
    expect(isContextLimitReached({ tokens: 100, contextWindow: 100, percent: 100 })).toBe(true);
    expect(isContextLimitReached({ tokens: 101, contextWindow: 100, percent: 101 })).toBe(true);
    expect(isContextLimitReached({ tokens: 99, contextWindow: 100, percent: 99 })).toBe(false);
  });

  it("isContextLimitReached is false when context usage is unknown", () => {
    expect(isContextLimitReached(null)).toBe(false);
    expect(isContextLimitReached({ tokens: null, contextWindow: 100000, percent: null })).toBe(false);
  });

  it("contextLimitMessage includes token counts and window", () => {
    const msg = contextLimitMessage({ tokens: 128001, contextWindow: 128000, percent: 100 });
    expect(msg).toContain("128001/128000");
    expect(msg).toContain("100%");
  });
});
