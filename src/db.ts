import { createPool, type Pool, type PoolConnection, type RowDataPacket, type ResultSetHeader } from "mysql2/promise";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { config, ROOT } from "./config.js";
import { createLogger } from "./logger.js";

const log = createLogger("db");

const __dirname = fileURLToPath(new URL(".", import.meta.url));


class Database {
  private _pool: Pool | null = null;

  get pool(): Pool {
    if (!this._pool) throw new Error("Database not initialized");
    return this._pool;
  }

  async init(): Promise<void> {
    if (this._pool) return;

    await this.ensureDatabaseExists();

    this._pool = createPool({
      host: config.dbHost,
      port: config.dbPort,
      user: config.dbUser,
      password: config.dbPassword,
      database: config.dbName,
      waitForConnections: true,
      connectionLimit: config.dbConnectionLimit,
      queueLimit: 0,
      timezone: "+00:00",
      // Resilience against silently dropped idle connections (MySQL
      // wait_timeout, NAT/firewall idle timeouts): TCP keepalive keeps the
      // socket alive, idleTimeout retires pooled connections before the
      // server kills them, and the timeouts make failures fast instead of
      // hanging requests until the OS TCP retransmission limit (~2 min).
      enableKeepAlive: true,
      keepAliveInitialDelay: 30_000,
      connectTimeout: config.dbConnectTimeoutMs,
      idleTimeout: config.dbIdleTimeoutMs,
      maxIdle: config.dbConnectionLimit,
    });
    // App code writes UTC wall times (toMySqlDateTime) and the pool parses
    // DATETIME as UTC (timezone: "+00:00"). Pin the MySQL session time_zone to
    // UTC as well so server-side NOW()/CURRENT_TIMESTAMP defaults produce UTC
    // too —otherwise those values land 8h off on a +08:00 server.
    this._pool.on("connection", (conn) => {
      conn.query("SET time_zone = '+00:00'");
    });

    this._pool.on("connection", (conn) => {
      conn.on("error", (err) => {
        log.warn("pooled connection error", err.message);
      });
    });

    // Verify connectivity
    const conn = await this._pool.getConnection();
    try {
      await conn.ping();
      log.info(`connected to mysql://${config.dbHost}:${config.dbPort}/${config.dbName}`);
    } finally {
      conn.release();
    }

    await this.runMigrations();
  }

  async close(): Promise<void> {
    if (this._pool) {
      await this._pool.end();
      this._pool = null;
    }
  }

  async query(sql: string, params?: any[]): Promise<RowDataPacket[]> {
    const [rows] = await this.timedExecute(sql, params);
    return rows as RowDataPacket[];
  }

  async execute(sql: string, params?: any[]): Promise<ResultSetHeader> {
    const [result] = await this.timedExecute(sql, params);
    return result as ResultSetHeader;
  }

  /** Ping the database with a timeout; used by health checks and heartbeat. */
  async ping(timeoutMs = 5000): Promise<number> {
    const start = Date.now();
    await Promise.race([
      this.pool.execute("SELECT 1"),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`db ping timeout after ${timeoutMs}ms`)), timeoutMs)
      ),
    ]);
    return Date.now() - start;
  }

  /** Best-effort pool statistics for health reporting. */
  poolStats(): { total: number; free: number; queued: number } | null {
    if (!this._pool) return null;
    const internal = (this._pool as any).pool;
    if (!internal) return null;
    return {
      total: internal._allConnections?.length ?? 0,
      free: internal._freeConnections?.length ?? 0,
      queued: internal._connectionQueue?.length ?? 0,
    };
  }

  private async timedExecute(sql: string, params?: any[]): Promise<[any, any]> {
    const start = Date.now();
    let timeout: NodeJS.Timeout | null = null;
    let timedOut = false;
    let conn: PoolConnection | null = null;
    try {
      conn = await this.pool.getConnection();
      const result = await Promise.race([
        conn.execute(sql, params),
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => {
            timedOut = true;
            reject(new Error(`db query timeout after ${config.dbQueryTimeoutMs}ms: ${sql.slice(0, 100)}`));
          }, config.dbQueryTimeoutMs);
        }),
      ]);
      return result as [any, any];
    } catch (err: any) {
      log.error("query failed", { sql: sql.slice(0, 200), durationMs: Date.now() - start, error: err.message, code: err.code });
      throw err;
    } finally {
      if (timeout) clearTimeout(timeout);
      if (conn) {
        if (timedOut) {
          // The query may still be hung on this connection; releasing it back
          // to the pool would corrupt the next borrower. Destroy the socket
          // so the pool never reuses a connection with an in-flight query.
          conn.destroy();
        } else {
          conn.release();
        }
      }
      const durationMs = Date.now() - start;
      if (durationMs >= config.slowQueryMs) {
        log.warn("slow query", { sql: sql.slice(0, 200), durationMs });
      }
    }
  }

  private async ensureDatabaseExists(): Promise<void> {
    const tempPool = createPool({
      host: config.dbHost,
      port: config.dbPort,
      user: config.dbUser,
      password: config.dbPassword,
      waitForConnections: true,
      connectionLimit: 1,
      queueLimit: 0,
      timezone: "+00:00",
    });
    try {
      await tempPool.execute(
        `CREATE DATABASE IF NOT EXISTS ${config.dbName} CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`
      );
    } finally {
      await tempPool.end();
    }
  }

  private async runMigrations(): Promise<void> {
    const migrationPath = resolve(__dirname, "..", "migrations", "001_init.sql");
    const sql = readFileSync(migrationPath, "utf-8");
    const statements = sql
      .split(";")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);

    const conn = await this.pool.getConnection();
    try {
      for (const statement of statements) {
        await conn.execute(statement);
      }
      log.info("migrations applied");
    } finally {
      conn.release();
    }

    await this.ensureSessionTitleColumn();
    await this.ensureSessionUsageColumns();
  }



  // Databases created before the usage columns existed are not altered by the
  // CREATE TABLE IF NOT EXISTS migration, so patch them idempotently here.
  private async ensureSessionUsageColumns(): Promise<void> {
    const required: Array<{ name: string; type: string }> = [
      { name: "usage_input_tokens", type: "BIGINT UNSIGNED DEFAULT 0" },
      { name: "usage_output_tokens", type: "BIGINT UNSIGNED DEFAULT 0" },
      { name: "usage_cache_read_tokens", type: "BIGINT UNSIGNED DEFAULT 0" },
      { name: "usage_cache_write_tokens", type: "BIGINT UNSIGNED DEFAULT 0" },
      { name: "usage_total_tokens", type: "BIGINT UNSIGNED DEFAULT 0" },
      { name: "cost", type: "DECIMAL(12,6) DEFAULT 0" },
      { name: "context_window", type: "INT UNSIGNED DEFAULT NULL" },
      { name: "context_tokens", type: "INT UNSIGNED DEFAULT NULL" },
      { name: "context_percent", type: "DECIMAL(5,2) DEFAULT NULL" },
    ];
    for (const col of required) {
      const rows = await this.query(
        `SELECT COUNT(*) AS cnt FROM information_schema.COLUMNS
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'sessions' AND COLUMN_NAME = ?`,
        [col.name],
      );
      if (Number((rows[0] as any).cnt) === 0) {
        await this.execute(`ALTER TABLE sessions ADD COLUMN ${col.name} ${col.type}`);
        log.info(`migration: added sessions.${col.name} column`);
      }
    }
  }

  // Databases created before sessions.title existed are not altered by the
  // CREATE TABLE IF NOT EXISTS migration, so patch them here idempotently.
  private async ensureSessionTitleColumn(): Promise<void> {
    const rows = await this.query(
      `SELECT COUNT(*) AS cnt FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'sessions' AND COLUMN_NAME = 'title'`,
    );
    if (Number((rows[0] as any).cnt) === 0) {
      await this.execute("ALTER TABLE sessions ADD COLUMN title VARCHAR(255) DEFAULT NULL AFTER agent_id");
      log.info("migration: added sessions.title column");
    }
  }
}

export function toMySqlDateTime(iso: string): string {
  return iso.replace("T", " ").replace("Z", "");
}

export const db = new Database();
