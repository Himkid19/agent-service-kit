import { describe, expect, it, vi } from "vitest";
import { errorHandler } from "../src/middleware/error.js";

describe("error handler", () => {
  it("does not expose unexpected internal error details", () => {
    const json = vi.fn();
    const status = vi.fn(() => ({ json }));
    const req = { method: "GET", originalUrl: "/test", ip: "127.0.0.1" };
    const res = { status, getHeader: () => "request-id" };

    errorHandler(
      new Error("database password=secret"),
      req as any,
      res as any,
      vi.fn(),
    );

    expect(status).toHaveBeenCalledWith(500);
    expect(json).toHaveBeenCalledWith({ error: "Internal server error" });
  });
});
