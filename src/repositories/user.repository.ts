import { randomUUID } from "node:crypto";
import { db, toMySqlDateTime } from "../db.js";
import type { User, UserPublic } from "../types.js";

interface UserRow {
  id: string;
  username: string;
  password_hash: string;
  display_name: string;
  created_at: string;
}

function rowToUser(row: UserRow): User {
  return {
    id: row.id,
    username: row.username,
    passwordHash: row.password_hash,
    displayName: row.display_name,
    createdAt: row.created_at,
  };
}

export const userRepository = {
  async create(user: Omit<User, "id" > & { id?: string }): Promise<User> {
    const id = user.id ?? randomUUID();
    await db.execute(
      `INSERT INTO users (id, username, password_hash, display_name, created_at)
       VALUES (?, ?, ?, ?, ?)`,
      [id, user.username, user.passwordHash, user.displayName, toMySqlDateTime(user.createdAt)],
    );
    return { ...user, id } as User;
  },

  async findByUsername(username: string): Promise<User | undefined> {
    const rows = await db.query(
      "SELECT id, username, password_hash, display_name, created_at FROM users WHERE username = ?",
      [username],
    );
    if (rows.length === 0) return undefined;
    return rowToUser(rows[0] as unknown as UserRow);
  },

  async findById(id: string): Promise<User | undefined> {
    const rows = await db.query(
      "SELECT id, username, password_hash, display_name, created_at FROM users WHERE id = ?",
      [id],
    );
    if (rows.length === 0) return undefined;
    return rowToUser(rows[0] as unknown as UserRow);
  },

  async count(): Promise<number> {
    const rows = await db.query("SELECT COUNT(*) as count FROM users");
    return Number((rows[0] as any).count);
  },

  async deleteAll(): Promise<void> {
    await db.execute("DELETE FROM users");
  },

  toPublic(user: User): UserPublic {
    return { id: user.id, username: user.username, displayName: user.displayName };
  },
};
