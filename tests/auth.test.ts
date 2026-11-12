import { describe, it, expect, beforeAll } from "vitest";
import { authService } from "../src/services/auth.service.js";
import { userRepository } from "../src/repositories/user.repository.js";
import { config } from "../src/config.js";
import { resetAllTables } from "./db-test-utils.js";

describe("Auth Service", () => {
  beforeAll(async () => {
    config.dataDir = config.dataDir + "-auth-test";
    await resetAllTables();
    await authService.init();
  });

  it("should register a new user", async () => {
    const user = await authService.register("alice", "Passw0rd!123", "Alice");
    expect(user.username).toBe("alice");
    expect(user.displayName).toBe("Alice");
    expect(user.id).toBeDefined();
  });

  it("should reject duplicate registration", async () => {
    await expect(authService.register("alice", "Passw0rd!123"))
      .rejects.toThrow("User already exists");
  });

  it("should login with correct credentials", async () => {
    const result = await authService.login("alice", "Passw0rd!123");
    expect(result.token).toBeDefined();
    expect(result.token.split(".").length).toBe(3);
    expect(result.user.username).toBe("alice");
  });

  it("should reject wrong password", async () => {
    await expect(authService.login("alice", "wrongpass"))
      .rejects.toThrow("Invalid credentials");
  });

  it("should verify a valid token", async () => {
    const { token } = await authService.login("alice", "Passw0rd!123");
    const decoded = authService.verifyToken(token);
    expect(decoded.username).toBe("alice");
    expect(decoded.sub).toBeDefined();
  });

  it("should seed admin user when no users exist", async () => {
    // seedAdmin is a no-op when users exist
    await authService.seedAdmin();
    // Admin was NOT seeded since we already have users
    expect(await authService.getUser("admin")).toBeUndefined();
  });

  it("should find user by id", async () => {
    const user = await userRepository.findByUsername("alice");
    const found = await authService.getUserById(user!.id);
    expect(found?.username).toBe("alice");
  });

  it("should reject weak passwords on register", async () => {
    await expect(authService.register("bob", "admin123"))
      .rejects.toThrow("too weak");
    await expect(authService.register("bob", "password123"))
      .rejects.toThrow("too weak");
  });

  it("should reject short passwords on register", async () => {
    await expect(authService.register("bob", "123456"))
      .rejects.toThrow("at least 8 characters");
  });

  it("should reject username-as-password on register", async () => {
    await expect(authService.register("Carol1234", "Carol1234"))
      .rejects.toThrow("same as username");
  });

  it("should seed admin with ADMIN_INITIAL_PASSWORD when no users exist", async () => {
    await resetAllTables();
    const original = config.adminInitialPassword;
    config.adminInitialPassword = "Str0ng!P@ssw0rd1";
    try {
      await authService.seedAdmin();
      const admin = await authService.getUser("admin");
      expect(admin?.username).toBe("admin");
      const result = await authService.login("admin", "Str0ng!P@ssw0rd1");
      expect(result.token).toBeDefined();
      // The old hardcoded default must NOT work.
      await expect(authService.login("admin", "admin123"))
        .rejects.toThrow("Invalid credentials");
    } finally {
      config.adminInitialPassword = original;
    }
  });

  it("should seed admin with a generated password when no env password is set", async () => {
    await resetAllTables();
    const original = config.adminInitialPassword;
    config.adminInitialPassword = "";
    try {
      await authService.seedAdmin();
      const admin = await authService.getUser("admin");
      expect(admin).toBeDefined();
      // The old hardcoded default must NOT work.
      await expect(authService.login("admin", "admin123"))
        .rejects.toThrow("Invalid credentials");
    } finally {
      config.adminInitialPassword = original;
    }
  });
});
