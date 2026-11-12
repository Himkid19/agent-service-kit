import { describe, it, expect, beforeEach } from "vitest";
import { loginGuard } from "../src/services/login-guard.js";
import { config } from "../src/config.js";

describe("LoginGuard (brute-force lockout)", () => {
  beforeEach(() => {
    loginGuard.clear();
  });

  it("allows attempts below the threshold", () => {
    for (let i = 0; i < config.loginMaxAttempts - 1; i++) {
      loginGuard.recordFailure("1.2.3.4", "admin");
    }
    expect(loginGuard.isLocked("1.2.3.4", "admin")).toBe(false);
    expect(loginGuard.remainingAttempts("1.2.3.4", "admin")).toBe(1);
  });

  it("locks after max failed attempts", () => {
    for (let i = 0; i < config.loginMaxAttempts; i++) {
      loginGuard.recordFailure("1.2.3.4", "admin");
    }
    expect(loginGuard.isLocked("1.2.3.4", "admin")).toBe(true);
    expect(loginGuard.lockRemainingMs("1.2.3.4", "admin")).toBeGreaterThan(0);
  });

  it("locks per ip+username, not globally", () => {
    for (let i = 0; i < config.loginMaxAttempts; i++) {
      loginGuard.recordFailure("1.2.3.4", "admin");
    }
    expect(loginGuard.isLocked("1.2.3.4", "admin")).toBe(true);
    expect(loginGuard.isLocked("1.2.3.4", "other")).toBe(false);
    expect(loginGuard.isLocked("5.6.7.8", "admin")).toBe(false);
  });

  it("resets after a successful login", () => {
    for (let i = 0; i < config.loginMaxAttempts; i++) {
      loginGuard.recordFailure("1.2.3.4", "admin");
    }
    expect(loginGuard.isLocked("1.2.3.4", "admin")).toBe(true);
    loginGuard.reset("1.2.3.4", "admin");
    expect(loginGuard.isLocked("1.2.3.4", "admin")).toBe(false);
    expect(loginGuard.remainingAttempts("1.2.3.4", "admin")).toBe(config.loginMaxAttempts);
  });

  it("honors the configured lockout duration", async () => {
    const originalMs = config.loginLockoutMs;
    config.loginLockoutMs = 50;
    try {
      for (let i = 0; i < config.loginMaxAttempts; i++) {
        loginGuard.recordFailure("1.2.3.4", "admin");
      }
      expect(loginGuard.isLocked("1.2.3.4", "admin")).toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 120));
      expect(loginGuard.isLocked("1.2.3.4", "admin")).toBe(false);
    } finally {
      config.loginLockoutMs = originalMs;
    }
  });
});
