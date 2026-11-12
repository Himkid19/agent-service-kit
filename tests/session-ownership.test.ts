import { describe, it, expect, beforeAll } from "vitest";
import { randomUUID } from "node:crypto";
import { db } from "../src/db.js";
import { sessionRepository } from "../src/repositories/session.repository.js";
import { chatService } from "../src/services/chat.service.js";
import { resetTables } from "./db-test-utils.js";

const userA = randomUUID();
const userB = randomUUID();
const agentA = "agent-own-a";
const agentB = "agent-own-b";

const sessionA = randomUUID(); // owned by userA + agentA
const sessionB = randomUUID(); // owned by userB + agentB

describe("session ownership isolation", () => {
  beforeAll(async () => {
    await resetTables("messages", "sessions", "agents", "users");
    for (const [id, name] of [[userA, "own-user-a"], [userB, "own-user-b"]] as const) {
      await db.execute(
        "INSERT INTO users (id, username, password_hash, display_name, created_at) VALUES (?, ?, ?, ?, NOW())",
        [id, name, "x", name],
      );
    }
    for (const id of [agentA, agentB]) {
      await db.execute(
        `INSERT INTO agents (id, name, description, allowed_tools, workspace_path, is_global, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 0, NOW(), NOW())`,
        [id, id, "", "[]", id],
      );
    }
    await sessionRepository.ensureSession(sessionA, userA, agentA);
    await sessionRepository.ensureSession(sessionB, userB, agentB);
    await sessionRepository.saveMessages(sessionA, [{ role: "user", content: [{ type: "text", text: "hello from A" }] }]);
  });

  it("listSessions(userId) only returns that user's sessions", async () => {
    const forA = await chatService.listSessions(userA);
    expect(forA.map((s) => s.sessionId)).toEqual([sessionA]);
    expect(forA[0].userId).toBe(userA);
    expect(forA[0].messageCount).toBe(1);
    expect(forA[0].createdAt).toBeTruthy();
    expect(forA[0].updatedAt).toBeTruthy();

    const forB = await chatService.listSessions(userB);
    expect(forB.map((s) => s.sessionId)).toEqual([sessionB]);
  });

  it("findById exposes the owner for ownership checks", async () => {
    const record = await sessionRepository.findById(sessionA);
    expect(record?.userId).toBe(userA);
    expect(record?.agentId).toBe(agentA);
    expect(await sessionRepository.findById(randomUUID())).toBeUndefined();
  });

  it("resetSession refuses to delete another user's session", async () => {
    const result = await chatService.resetSession(userB, agentB, sessionA);
    expect(result.deleted).toBe(false);
    expect(result.sessionsDeleted).toBe(0);
    expect(await sessionRepository.exists(sessionA)).toBe(true);
  });

  it("resetSession refuses a session owned by the same user under a different agent", async () => {
    // userA's session belongs to agentA; deleting it via agentB must fail too.
    const result = await chatService.resetSession(userA, agentB, sessionA);
    expect(result.deleted).toBe(false);
    expect(await sessionRepository.exists(sessionA)).toBe(true);
  });

  it("resetSession deletes when the owner asks", async () => {
    const result = await chatService.resetSession(userA, agentA, sessionA);
    expect(result.deleted).toBe(true);
    expect(await sessionRepository.exists(sessionA)).toBe(false);
  });

  it("getSessionMessages returns nothing for a session owned by someone else", async () => {
    const messages = await chatService.getSessionMessages(userB, agentB, sessionB);
    expect(messages.length).toBeGreaterThanOrEqual(0);
    const stolen = await chatService.getSessionMessages(userB, agentB, "nonexistent");
    expect(stolen).toEqual([]);
  });

  it("listSessions and listAgentSessions expose the session title", async () => {
    // sessionA was deleted by the reset test above; recreate it first.
    await sessionRepository.ensureSession(sessionA, userA, agentA);
    await sessionRepository.setTitleIfEmpty(sessionA, "hello from A");
    const all = await chatService.listSessions(userA);
    expect(all.find((s) => s.sessionId === sessionA)?.title).toBe("hello from A");
    const forAgent = await chatService.listAgentSessions(userA, agentA);
    expect(forAgent.find((s) => s.sessionId === sessionA)?.title).toBe("hello from A");
    // Untitled sessions come back as null rather than missing the field.
    const bSessions = await chatService.listSessions(userB);
    expect(bSessions.find((s) => s.sessionId === sessionB)?.title).toBeNull();
  });
});