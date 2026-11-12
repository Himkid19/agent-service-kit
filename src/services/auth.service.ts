import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { randomBytes, randomUUID } from "node:crypto";
import { config } from "../config.js";
import { HttpError } from "../middleware/error.js";
import { userRepository } from "../repositories/user.repository.js";
import type { User, UserPublic } from "../types.js";
import { createLogger } from "../logger.js";

const log = createLogger("auth");

/** Common weak passwords that must never be accepted (case-insensitive). */
const WEAK_PASSWORDS = new Set([
  "admin",
  "admin123",
  "admin123456",
  "admin888",
  "password",
  "password123",
  "123456",
  "12345678",
  "123456789",
  "1234567890",
  "qwerty",
  "qwerty123",
  "abc123",
  "123123",
  "111111",
  "000000",
  "666666",
  "888888",
  "root",
  "root123",
  "toor",
  "test",
  "test123",
  "welcome",
  "welcome123",
  "letmein",
  "passw0rd",
  "p@ssw0rd",
  "1qaz2wsx",
  "a1b2c3",
]);

function validatePassword(username: string, password: string): void {
  if (typeof password !== "string" || password.length < 8) {
    throw new HttpError(400, "Password must be at least 8 characters long");
  }
  if (!/[a-zA-Z]/.test(password) || !/\d/.test(password)) {
    throw new HttpError(400, "Password must contain both letters and numbers");
  }
  if (WEAK_PASSWORDS.has(password.toLowerCase())) {
    throw new HttpError(400, "Password is too weak (commonly used password)");
  }
  if (password.toLowerCase() === username.toLowerCase()) {
    throw new HttpError(400, "Password cannot be the same as username");
  }
}

/** Strong random password: prefix + 24 base64url chars (letters+digits+symbols).
 *  Retries until it satisfies the letter+digit policy (base64url can rarely
 *  contain no digits). */
function generateStrongPassword(): string {
  for (let i = 0; i < 10; i++) {
    const p = `Nlc${randomBytes(18).toString("base64url")}`;
    if (/[a-zA-Z]/.test(p) && /\d/.test(p)) return p;
  }
  return `Nlc${randomBytes(18).toString("base64url")}9`;
}

class AuthService {
  async init(): Promise<void> {
    // No-op: users are loaded from MySQL on demand
  }

  async register(username: string, password: string, displayName?: string): Promise<UserPublic> {
    if (!username || !password) {
      throw new HttpError(400, "username and password required");
    }
    validatePassword(username, password);
    const existing = await userRepository.findByUsername(username);
    if (existing) {
      throw new HttpError(409, "User already exists");
    }
    const passwordHash = await bcrypt.hash(password, 10);
    const user: User = {
      id: randomUUID(),
      username,
      passwordHash,
      displayName: displayName || username,
      createdAt: new Date().toISOString(),
    };
    const created = await userRepository.create(user);
    return userRepository.toPublic(created);
  }

  async login(username: string, password: string): Promise<{ token: string; user: UserPublic }> {
    const user = await userRepository.findByUsername(username);
    if (!user) throw new HttpError(401, "Invalid credentials");
    const ok = await bcrypt.compare(password, user.passwordHash);
    if (!ok) throw new HttpError(401, "Invalid credentials");
    const token = jwt.sign({ sub: user.id, username: user.username }, config.jwtSecret, {
      expiresIn: "24h",
    });
    return { token, user: userRepository.toPublic(user) };
  }

  verifyToken(token: string): { sub: string; username: string } {
    return jwt.verify(token, config.jwtSecret) as { sub: string; username: string };
  }

  async getUser(username: string): Promise<UserPublic | undefined> {
    const u = await userRepository.findByUsername(username);
    return u ? userRepository.toPublic(u) : undefined;
  }

  async getUserById(id: string): Promise<UserPublic | undefined> {
    const u = await userRepository.findById(id);
    return u ? userRepository.toPublic(u) : undefined;
  }

  /** Seed a default admin user if none exist */
  async seedAdmin(): Promise<void> {
    const count = await userRepository.count();
    if (count > 0) return;
    const password = config.adminInitialPassword || generateStrongPassword();
    // Bypass the weak-password policy only for the bootstrap account, but
    // still reject an explicitly-provided weak ADMIN_INITIAL_PASSWORD.
    if (config.adminInitialPassword) {
      validatePassword("admin", password);
    }
    await this.register("admin", password, "Administrator");
    if (config.adminInitialPassword) {
      log.info("seeded default admin account with ADMIN_INITIAL_PASSWORD");
    } else {
      log.warn(
        `[SECURITY] Seeded default admin account with a generated password: ${password} ` +
          "(printed once; change it or set ADMIN_INITIAL_PASSWORD on the next deployment)",
      );
    }
  }
}

export const authService = new AuthService();
