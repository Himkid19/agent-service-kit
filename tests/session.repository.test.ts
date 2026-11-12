import { describe, it, expect, beforeAll } from "vitest";
import { randomUUID } from "node:crypto";
import { db } from "../src/db.js";
import { sessionRepository } from "../src/repositories/session.repository.js";
import { resetTables } from "./db-test-utils.js";

const userId = randomUUID();
const agentId = "agent-sesstest";

describe("sessionRepository.ensureSession", () => {
  beforeAll(async () => {
    await resetTables("messages", "sessions", "agents", "users");
    await db.execute(
      "INSERT INTO users (id, username, password_hash, display_name, created_at) VALUES (?, ?, ?, ?, NOW())",
      [userId, "sess-test-user", "x", "Sess Test"],
    );
    await db.execute(
      `INSERT INTO agents (id, name, description, allowed_tools, workspace_path, is_global, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 0, NOW(), NOW())`,
      [agentId, "sess-test-agent", "", "[]", "sess-test-agent"],
    );
  });

  it("is idempotent for the same sessionId (no duplicate-key error)", async () => {
    const sessionId = randomUUID();
    const first = await sessionRepository.ensureSession(sessionId, userId, agentId);
    // The "new session -> first message" flow calls ensureSession twice for
    // the same id; this must not raise ER_DUP_ENTRY.
    const second = await sessionRepository.ensureSession(sessionId, userId, agentId);
    expect(first.sessionId).toBe(sessionId);
    expect(second.sessionId).toBe(sessionId);
    expect(await sessionRepository.exists(sessionId)).toBe(true);
  });

  it("survives concurrent ensureSession calls for the same sessionId", async () => {
    const sessionId = randomUUID();
    await expect(
      Promise.all(
        Array.from({ length: 5 }, () =>
          sessionRepository.ensureSession(sessionId, userId, agentId),
        ),
      ),
    ).resolves.toHaveLength(5);
    const sessions = await sessionRepository.findByUserAndAgent(userId, agentId);
    expect(sessions.filter((s) => s.sessionId === sessionId)).toHaveLength(1);
  });

  it("touch updates updated_at without failing", async () => {
    const sessionId = randomUUID();
    await sessionRepository.ensureSession(sessionId, userId, agentId);
    await expect(sessionRepository.touch(sessionId)).resolves.toBeUndefined();
  });

  it("stores created_at/updated_at as UTC (NOW() matches toMySqlDateTime)", async () => {
    // Regression: server-side NOW() used the MySQL server timezone (+08:00)
    // while app writes and DATETIME parsing are UTC, leaving updated_at 8h off.
    const sessionId = randomUUID();
    await sessionRepository.ensureSession(sessionId, userId, agentId);
    await sessionRepository.touch(sessionId);
    const record = await sessionRepository.findById(sessionId);
    const created = new Date(record!.createdAt).getTime();
    const updated = new Date(record!.updatedAt).getTime();
    expect(Math.abs(Date.now() - created)).toBeLessThan(10_000);
    expect(Math.abs(Date.now() - updated)).toBeLessThan(10_000);
  });

  it("setTitleIfEmpty starts as null and only the first write wins", async () => {
    const sessionId = randomUUID();
    await sessionRepository.ensureSession(sessionId, userId, agentId);
    expect((await sessionRepository.findById(sessionId))!.title).toBeNull();

    expect(await sessionRepository.setTitleIfEmpty(sessionId, "first question")).toBe(true);
    expect((await sessionRepository.findById(sessionId))!.title).toBe("first question");

    // Later messages must not overwrite the title.
    expect(await sessionRepository.setTitleIfEmpty(sessionId, "second message")).toBe(false);
    expect((await sessionRepository.findById(sessionId))!.title).toBe("first question");
  });

  it("setTitleIfEmpty is race-safe for concurrent first messages", async () => {
    const sessionId = randomUUID();
    await sessionRepository.ensureSession(sessionId, userId, agentId);
    const results = await Promise.all(
      ["t1", "t2", "t3"].map((t) => sessionRepository.setTitleIfEmpty(sessionId, t)),
    );
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(["t1", "t2", "t3"]).toContain((await sessionRepository.findById(sessionId))!.title);
  });

  it("title is exposed in findById / listByUser / findByUserAndAgent", async () => {
    const sessionId = randomUUID();
    await sessionRepository.ensureSession(sessionId, userId, agentId);
    await sessionRepository.setTitleIfEmpty(sessionId, "list me");
    expect((await sessionRepository.findById(sessionId))!.title).toBe("list me");
    const byUser = (await sessionRepository.listByUser(userId)).find((s) => s.sessionId === sessionId);
    expect(byUser!.title).toBe("list me");
    const byAgent = (await sessionRepository.findByUserAndAgent(userId, agentId)).find((s) => s.sessionId === sessionId);
    expect(byAgent!.title).toBe("list me");
  });
});

describe("sessionRepository.saveMessages", () => {
  beforeAll(async () => {
    await resetTables("messages", "sessions", "agents", "users");
    await db.execute(
      "INSERT INTO users (id, username, password_hash, display_name, created_at) VALUES (?, ?, ?, ?, NOW())",
      [userId, "sess-test-user", "x", "Sess Test"],
    );
    await db.execute(
      `INSERT INTO agents (id, name, description, allowed_tools, workspace_path, is_global, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 0, NOW(), NOW())`,
      [agentId, "sess-test-agent", "", "[]", "sess-test-agent"],
    );
  });

  it("normalizes undefined message content instead of crashing on bind params", async () => {
    // Regression: a failed/aborted stream leaves the last assistant message
    // with undefined content. JSON.stringify(undefined) === undefined, which
    // mysql2 rejected as "Bind parameters must not contain undefined".
    const sessionId = randomUUID();
    await sessionRepository.ensureSession(sessionId, userId, agentId);

    await expect(
      sessionRepository.saveMessages(sessionId, [
        { role: "user", content: "test question" },
        { role: "assistant", content: undefined, stopReason: "error", errorMessage: "Stream ended without finish_reason" },
      ]),
    ).resolves.toBeUndefined();

    const messages = await sessionRepository.getSessionMessages(sessionId);
    expect(messages).toHaveLength(2);
    expect(messages[1].role).toBe("assistant");
    expect(messages[1].content).toBe("");
  });

  it("round-trips string and array content without loss", async () => {
    const sessionId = randomUUID();
    await sessionRepository.ensureSession(sessionId, userId, agentId);
    await sessionRepository.saveMessages(sessionId, [
      { role: "user", content: "hello" },
      { role: "assistant", content: [{ type: "text", text: "world" }] },
    ]);
    const messages = await sessionRepository.getSessionMessages(sessionId);
    expect(messages[0].content).toBe("hello");
    expect(messages[1].content).toContain("world");
  });
});
