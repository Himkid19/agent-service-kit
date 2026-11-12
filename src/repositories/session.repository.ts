import { db, toMySqlDateTime } from "../db.js";

export interface TokenUsageRecord {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  cost: number;
}

export interface ContextUsageRecord {
  tokens: number | null;
  contextWindow: number;
  percent: number | null;
}

export interface SessionRecord {
  sessionId: string;
  userId: string;
  agentId: string;
  title: string | null;
  createdAt: string;
  updatedAt: string;
  usage: TokenUsageRecord;
  contextUsage: ContextUsageRecord | null;
}

export interface MessageRecord {
  id: number;
  sessionId: string;
  role: string;
  content: any;
  metadata: any;
  createdAt: string;
}

function toRecord(r: any): SessionRecord {
  return {
    sessionId: r.session_id,
    userId: r.user_id,
    agentId: r.agent_id,
    title: r.title ?? null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    usage: {
      inputTokens: Number(r.usage_input_tokens ?? 0),
      outputTokens: Number(r.usage_output_tokens ?? 0),
      cacheReadTokens: Number(r.usage_cache_read_tokens ?? 0),
      cacheWriteTokens: Number(r.usage_cache_write_tokens ?? 0),
      totalTokens: Number(r.usage_total_tokens ?? 0),
      cost: Number(r.cost ?? 0),
    },
    contextUsage:
      r.context_window != null
        ? {
            tokens: r.context_tokens != null ? Number(r.context_tokens) : null,
            contextWindow: Number(r.context_window),
            percent: r.context_percent != null ? Number(r.context_percent) : null,
          }
        : null,
  };
}

export const sessionRepository = {
  async ensureSession(sessionId: string, userId: string, agentId: string): Promise<SessionRecord> {
    const now = toMySqlDateTime(new Date().toISOString());
    // Atomic upsert: the common "new session -> first message" flow calls this
    // twice for the same sessionId, and concurrent sends can race here. The
    // previous insert-then-catch-ER_DUP_ENTRY approach worked but produced a
    // scary ERROR log on every expected duplicate.
    await db.execute(
      `INSERT INTO sessions (session_id, user_id, agent_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE updated_at = VALUES(updated_at)`,
      [sessionId, userId, agentId, now, now],
    );
    return {
      sessionId, userId, agentId, title: null,
      createdAt: now, updatedAt: now,
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0, cost: 0 },
      contextUsage: null,
    };
  },

  async touch(sessionId: string): Promise<void> {
    await db.execute(
      "UPDATE sessions SET updated_at = NOW() WHERE session_id = ?",
      [sessionId],
    );
  },

  // Only fills in the title once: the first user message of a session wins,
  // and the IS NULL guard makes concurrent first-message races idempotent.
  async setTitleIfEmpty(sessionId: string, title: string): Promise<boolean> {
    const result = await db.execute(
      "UPDATE sessions SET title = ? WHERE session_id = ? AND title IS NULL",
      [title, sessionId],
    );
    return (result.affectedRows ?? 0) > 0;
  },

  async exists(sessionId: string): Promise<boolean> {
    const rows = await db.query("SELECT 1 FROM sessions WHERE session_id = ?", [sessionId]);
    return rows.length > 0;
  },

  async findById(sessionId: string): Promise<SessionRecord | undefined> {
    const rows = await db.query(
      `SELECT session_id, user_id, agent_id, title, created_at, updated_at,
              usage_input_tokens, usage_output_tokens, usage_cache_read_tokens,
              usage_cache_write_tokens, usage_total_tokens, cost,
              context_window, context_tokens, context_percent
       FROM sessions WHERE session_id = ?`,
      [sessionId],
    );
    return rows.length > 0 ? toRecord(rows[0]) : undefined;
  },

  async findByUserAndAgent(userId: string, agentId: string): Promise<SessionRecord[]> {
    const rows = await db.query(
      `SELECT session_id, user_id, agent_id, title, created_at, updated_at,
              usage_input_tokens, usage_output_tokens, usage_cache_read_tokens,
              usage_cache_write_tokens, usage_total_tokens, cost,
              context_window, context_tokens, context_percent
       FROM sessions
       WHERE user_id = ? AND agent_id = ?
       ORDER BY updated_at DESC`,
      [userId, agentId],
    );
    return rows.map(toRecord);
  },

  async listByUser(userId: string): Promise<SessionRecord[]> {
    const rows = await db.query(
      `SELECT session_id, user_id, agent_id, title, created_at, updated_at,
              usage_input_tokens, usage_output_tokens, usage_cache_read_tokens,
              usage_cache_write_tokens, usage_total_tokens, cost,
              context_window, context_tokens, context_percent
       FROM sessions
       WHERE user_id = ?
       ORDER BY updated_at DESC`,
      [userId],
    );
    return rows.map(toRecord);
  },

  async listAll(): Promise<SessionRecord[]> {
    const rows = await db.query(
      `SELECT session_id, user_id, agent_id, title, created_at, updated_at,
              usage_input_tokens, usage_output_tokens, usage_cache_read_tokens,
              usage_cache_write_tokens, usage_total_tokens, cost,
              context_window, context_tokens, context_percent
       FROM sessions ORDER BY updated_at DESC`,
    );
    return rows.map(toRecord);
  },

  async getCurrentSessionId(userId: string, agentId: string): Promise<string | undefined> {
    const rows = await db.query(
      `SELECT session_id FROM sessions
       WHERE user_id = ? AND agent_id = ?
       ORDER BY updated_at DESC LIMIT 1`,
      [userId, agentId],
    );
    return rows.length > 0 ? (rows[0] as any).session_id : undefined;
  },

  async saveMessages(sessionId: string, messages: any[]): Promise<void> {
    await db.execute("DELETE FROM messages WHERE session_id = ?", [sessionId]);
    for (const m of messages) {
      // messages.content is a JSON column, so every value must be
      // JSON-encoded. Two failure modes are handled here:
      //  1. undefined content (failed/aborted stream): JSON.stringify(undefined)
      //     returns undefined, which mysql2 rejects as a bind parameter.
      //  2. plain string content: storing a bare string into a JSON column
      //     fails with "Invalid JSON text". Always JSON-encode.
      const raw = m?.content;
      const content = raw == null ? JSON.stringify("") : JSON.stringify(raw) ?? JSON.stringify("");
      const meta = { ...m };
      delete meta.role;
      delete meta.content;
      await db.execute(
        `INSERT INTO messages (session_id, role, content, metadata, created_at)
         VALUES (?, ?, ?, ?, ?)`,
        [sessionId, m?.role ?? "assistant", content, JSON.stringify(meta), toMySqlDateTime(new Date().toISOString())],
      );
    }
  },

  async loadMessages(sessionId: string): Promise<any[]> {
    const rows = await db.query(
      `SELECT role, content, metadata FROM messages
       WHERE session_id = ?
       ORDER BY id ASC`,
      [sessionId],
    );
    return rows.map((r) => {
      const row = r as any;
      let content = row.content;
      if (typeof content === "string") {
        try { content = JSON.parse(content); } catch { /* leave as string */ }
      }
      let metadata = row.metadata;
      if (typeof metadata === "string") {
        try { metadata = JSON.parse(metadata); } catch { metadata = {}; }
      }
      return { role: row.role, content, ...(metadata ?? {}) };
    });
  },

  async countMessages(sessionId: string): Promise<number> {
    const rows = await db.query("SELECT COUNT(*) as count FROM messages WHERE session_id = ?", [sessionId]);
    return Number((rows[0] as any).count);
  },

  async getSessionMessages(sessionId: string): Promise<{ role: string; content: string }[]> {
    const rows = await db.query(
      `SELECT role, content FROM messages WHERE session_id = ? ORDER BY id ASC`,
      [sessionId],
    );
    return rows.map((r) => {
      const row = r as any;
      let content = row.content;
      if (typeof content === "string") {
        try { content = JSON.parse(content); } catch { /* keep as string */ }
      }
      return {
        role: row.role,
        content: typeof content === "string" ? content : JSON.stringify(content),
      };
    });
  },

  async deleteSession(sessionId: string): Promise<void> {
    await db.execute("DELETE FROM sessions WHERE session_id = ?", [sessionId]);
  },

  async deleteByUserAndAgent(userId: string, agentId: string): Promise<number> {
    const result = await db.execute(
      "DELETE FROM sessions WHERE user_id = ? AND agent_id = ?",
      [userId, agentId],
    );
    return result.affectedRows ?? 0;
  },


  async updateUsage(
    sessionId: string,
    usage: TokenUsageRecord,
    contextUsage: ContextUsageRecord | null,
  ): Promise<void> {
    await db.execute(
      `UPDATE sessions SET
        usage_input_tokens = ?,
        usage_output_tokens = ?,
        usage_cache_read_tokens = ?,
        usage_cache_write_tokens = ?,
        usage_total_tokens = ?,
        cost = ?,
        context_window = ?,
        context_tokens = ?,
        context_percent = ?
       WHERE session_id = ?`,
      [
        usage.inputTokens,
        usage.outputTokens,
        usage.cacheReadTokens,
        usage.cacheWriteTokens,
        usage.totalTokens,
        usage.cost,
        contextUsage?.contextWindow ?? null,
        contextUsage?.tokens ?? null,
        contextUsage?.percent ?? null,
        sessionId,
      ],
    );
  },
  async deleteAll(): Promise<void> {
    await db.execute("DELETE FROM sessions");
  },
};
