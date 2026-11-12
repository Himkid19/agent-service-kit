import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { Server } from "node:http";
import { createApp } from "../src/app.js";
import { authService } from "../src/services/auth.service.js";
import { loginGuard } from "../src/services/login-guard.js";
import { config } from "../src/config.js";
import { resetAllTables } from "./db-test-utils.js";

describe("Login API hardening (HTTP level)", () => {
  let server: Server;
  let baseUrl: string;

  beforeAll(async () => {
    await resetAllTables();
    await authService.register("alice", "Passw0rd!123", "Alice");
    const app = createApp();
    await new Promise<void>((resolve) => {
      server = app.listen(0, "127.0.0.1", () => resolve());
    });
    const addr = server.address();
    if (typeof addr === "object" && addr) {
      baseUrl = `http://127.0.0.1:${addr.port}`;
    }
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  beforeEach(() => {
    loginGuard.clear();
  });

  async function postLogin(username: string, password: string): Promise<Response> {
    return fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username, password }),
    });
  }

  it("returns 400 for weak registration passwords", async () => {
    const res = await fetch(`${baseUrl}/api/auth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "bob", password: "admin123" }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("too weak");
  });

  it("returns 401 for invalid credentials", async () => {
    const res = await postLogin("alice", "wrong-password");
    expect(res.status).toBe(401);
  });

  it("locks the account after repeated failures and returns 423", async () => {
    for (let i = 0; i < config.loginMaxAttempts; i++) {
      const res = await postLogin("alice", "wrong-password");
      expect(res.status).toBe(401);
    }
    const locked = await postLogin("alice", "wrong-password");
    expect(locked.status).toBe(423);
    const body = await locked.json();
    expect(body.code).toBe("ACCOUNT_LOCKED");
    expect(typeof body.retryAfterMs).toBe("number");
    expect(body.retryAfterMs).toBeGreaterThan(0);
  });

  it("only locks the offending ip+username pair", async () => {
    for (let i = 0; i < config.loginMaxAttempts; i++) {
      await postLogin("alice", "wrong-password");
    }
    expect((await postLogin("alice", "wrong-password")).status).toBe(423);
    // Same username from another IP is not blocked (we only have one loopback
    // IP in tests, so verify a different username on the same IP instead).
    const other = await postLogin("nobody", "wrong-password");
    expect(other.status).toBe(401);
  });

  it("allows login again after successful reset", async () => {
    for (let i = 0; i < config.loginMaxAttempts; i++) {
      await postLogin("alice", "wrong-password");
    }
    expect((await postLogin("alice", "wrong-password")).status).toBe(423);
    loginGuard.reset("127.0.0.1", "alice");
    const ok = await postLogin("alice", "Passw0rd!123");
    expect(ok.status).toBe(200);
    const body = await ok.json();
    expect(body.token).toBeDefined();
  });
});
