import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Server } from "node:http";
import { createApp } from "../src/app.js";
import { db } from "../src/db.js";

describe("Health endpoints", () => {
  let server: Server;
  let baseUrl: string;

  beforeAll(async () => {
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

  it("GET /api/health returns liveness info", async () => {
    const res = await fetch(`${baseUrl}/api/health`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("ok");
    expect(body.version).toBeDefined();
    expect(typeof body.uptimeSec).toBe("number");
    expect(body.timestamp).toBeDefined();
  });

  it("GET /api/health exposes memory and session/gate stats for leak monitoring", async () => {
    const res = await fetch(`${baseUrl}/api/health`);
    const body = await res.json();
    // Memory counters — the whole-machine-OOM incident made these must-haves.
    expect(typeof body.memory.rssBytes).toBe("number");
    expect(typeof body.memory.heapUsedBytes).toBe("number");
    expect(typeof body.memory.heapTotalBytes).toBe("number");
    expect(body.memory.rssBytes).toBeGreaterThan(0);
    // Bounded session cache stats.
    expect(typeof body.sessions.size).toBe("number");
    expect(typeof body.sessions.capacity).toBe("number");
    expect(body.sessions.capacity).toBeGreaterThanOrEqual(1);
    expect(typeof body.sessions.evictedIdle).toBe("number");
    expect(typeof body.sessions.evictedOther).toBe("number");
    // Concurrency gate stats.
    expect(typeof body.llmGate.limit).toBe("number");
    expect(body.llmGate.limit).toBeGreaterThanOrEqual(1);
    expect(typeof body.llmGate.active).toBe("number");
    expect(typeof body.llmGate.waiting).toBe("number");
  });

  it("GET /api/health/ready returns 200 with db reachability when DB is up", async () => {
    const res = await fetch(`${baseUrl}/api/health/ready`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("ok");
    expect(body.db.reachable).toBe(true);
    expect(typeof body.db.latencyMs).toBe("number");
    expect(body.db.pool).toBeDefined();
    expect(body.heartbeat).toBeDefined();
  });

  it("responses carry an X-Request-Id header", async () => {
    const res = await fetch(`${baseUrl}/api/health`);
    expect(res.headers.get("x-request-id")).toBeTruthy();
  });

  it("db.ping resolves with a latency number", async () => {
    const latency = await db.ping(3000);
    expect(typeof latency).toBe("number");
    expect(latency).toBeGreaterThanOrEqual(0);
  });
});
