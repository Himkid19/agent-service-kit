import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Server } from "node:http";
import { createApp } from "../src/app.js";
import { config } from "../src/config.js";

describe("frontend CORS configuration", () => {
  let server: Server;
  let baseUrl: string;
  const originalOrigin = config.corsOrigin;

  beforeAll(async () => {
    config.corsOrigin = "https://frontend.example";
    const app = createApp();
    await new Promise<void>((resolve) => {
      server = app.listen(0, "127.0.0.1", () => resolve());
    });
    const address = server.address();
    if (typeof address === "object" && address) {
      baseUrl = `http://127.0.0.1:${address.port}`;
    }
  });

  afterAll(async () => {
    config.corsOrigin = originalOrigin;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("allows the configured frontend origin", async () => {
    const response = await fetch(`${baseUrl}/api/health`, {
      headers: { Origin: "https://frontend.example" },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBe("https://frontend.example");
  });

  it("handles browser preflight requests for JSON POST APIs", async () => {
    const response = await fetch(`${baseUrl}/api/agents`, {
      method: "OPTIONS",
      headers: {
        Origin: "https://frontend.example",
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "authorization,content-type",
      },
    });
    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe("https://frontend.example");
  });
});
