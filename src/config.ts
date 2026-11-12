import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const ROOT = resolve(__dirname, "..");

/** Minimal .env loader —no dependency needed */
function loadDotenv(): void {
  const envFile = resolve(ROOT, ".env");
  if (!existsSync(envFile)) return;
  const raw = readFileSync(envFile, "utf-8");
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    // Strip surrounding quotes
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (!process.env[key]) {
      process.env[key] = val;
    }
  }
}

loadDotenv();

function env(key: string, fallback: string): string {
  return process.env[key] ?? fallback;
}

function readSecret(path: string): string | null {
  const full = resolve(ROOT, path);
  if (!existsSync(full)) return null;
  return readFileSync(full, "utf-8").trim();
}

const configuredJwtSecret =
  env("JWT_SECRET", readSecret("jwt-secret.txt") ?? "").trim();

if (!configuredJwtSecret && process.env.NODE_ENV === "production") {
  throw new Error("JWT_SECRET must be set when NODE_ENV=production");
}

export const config = {
  port: parseInt(env("PORT", "3001"), 10),
  host: env("HOST", "0.0.0.0"),
  jwtSecret: configuredJwtSecret || randomBytes(32).toString("hex"),

  // Initial password for the seeded default admin account.
  // Empty (default) => a strong random password is generated and printed in
  // the startup log once. Never fall back to a hardcoded weak credential.
  adminInitialPassword: env("ADMIN_INITIAL_PASSWORD", ""),

  // Optional request headers for gateways that require per-request tracing.
  llmTraceIdentifier: env("LLM_TRACE_IDENTIFIER", ""),
  llmTraceIdentifierType: env("LLM_TRACE_IDENTIFIER_TYPE", ""),

  // Login brute-force protection (in-memory, per process).
  loginMaxAttempts: Math.max(1, parseInt(env("LOGIN_MAX_ATTEMPTS", "5"), 10)),
  loginLockoutMs: Math.max(1, parseInt(env("LOGIN_LOCKOUT_MS", String(15 * 60 * 1000)), 10)),
  loginRateWindowMs: Math.max(1, parseInt(env("LOGIN_RATE_WINDOW_MS", String(15 * 60 * 1000)), 10)),
  workplacesDir: env("WORKPLACES_DIR", resolve(ROOT, "workplaces")),
  dataDir: env("DATA_DIR", resolve(ROOT, "data")),
  agentDir: env("AGENT_DIR", resolve(ROOT, ".pi")),

  // Agent registry file —placed outside dataDir so bind mounts on /app/data
  // don't hide the baked-in agents.json shipped with the Docker image.
  // Runtime agent changes (create / update / delete) are written back here
  // into the container writable layer; they are lost on `docker rm + docker run`.
  agentsFile: env("AGENTS_FILE", resolve(ROOT, "agents.json")),
  logLevel: env("LOG_LEVEL", "info"),

  // When "true", startup removes persisted agents whose workspace directory
  // no longer exists on disk. Opt-in because dev machines and the server may
  // share the same MySQL — a local run would otherwise delete server agents
  // (their /app/workplaces/... paths don't exist locally).
  pruneStaleAgents: env("PRUNE_STALE_AGENTS", "false") === "true",

  // Default LLM provider —set in .env to narrow per-agent scope
  defaultProvider: env("DEFAULT_PROVIDER", "openai"),
  defaultModel: env("DEFAULT_MODEL", "gpt-4o"),

  // MySQL persistence
  dbHost: env("DB_HOST", "127.0.0.1"),
  dbPort: parseInt(env("DB_PORT", "3306"), 10),
  dbUser: env("DB_USER", "root"),
  dbPassword: env("DB_PASSWORD", ""),
  dbName: env("DB_NAME", "agent_service_kit"),

  // MySQL pool resilience. Idle connections dropped by MySQL wait_timeout or
  // firewalls used to hang requests until the OS TCP timeout (~2 min -> 500).
  // idleTimeout makes the pool retire idle connections before that happens,
  // and a query timeout makes a starving/broken pool fail fast instead of
  // hanging a request forever.
  dbConnectTimeoutMs: parseInt(env("DB_CONNECT_TIMEOUT_MS", "10000"), 10),
  dbQueryTimeoutMs: parseInt(env("DB_QUERY_TIMEOUT_MS", "15000"), 10),
  dbIdleTimeoutMs: parseInt(env("DB_IDLE_TIMEOUT_MS", "60000"), 10),
  dbConnectionLimit: parseInt(env("DB_CONNECTION_LIMIT", "10"), 10),

  // Heartbeat: periodic DB ping to keep pool connections warm and surface
  // outages in the logs before a user request hits them.
  heartbeatIntervalMs: parseInt(env("HEARTBEAT_INTERVAL_MS", "30000"), 10),

  // Log a warning for DB queries slower than this threshold.
  slowQueryMs: parseInt(env("SLOW_QUERY_MS", "500"), 10),

  // Pre-configured provider (optional): set these in .env so agents don't
  // need per-request API key setup
  providerApiKey: env("PROVIDER_API_KEY", ""),
  providerBaseUrl: env("PROVIDER_BASE_URL", ""),
  providerName: env("PROVIDER_NAME", ""),

  // Stream timeout in milliseconds. Default: 5 minutes (300_000).
  // Set STREAM_TIMEOUT_MS in .env to override. Complex agents (multi-tool,
  // multi-turn) need longer than the old 120s default.
  streamTimeoutMs: parseInt(env("STREAM_TIMEOUT_MS", "300000"), 10),

  // Concurrency limit for LLM calls. Default: 2 concurrent calls.
  // Set MAX_CONCURRENT_LLM_CALLS in .env to override.
  maxConcurrentLlmCalls: parseInt(env("MAX_CONCURRENT_LLM_CALLS", "2"), 10),
  // How long a request may wait in the LLM concurrency queue before failing
  // fast. Default: 5 minutes — aligned with STREAM_TIMEOUT_MS so a queued
  // request never survives its own client-side stream timeout.
  llmQueueTimeoutMs: parseInt(env("LLM_QUEUE_TIMEOUT_MS", "300000"), 10),

  // In-memory agent-session cache limits. Sessions idle longer than the TTL
  // are disposed by the periodic sweeper; inserting beyond the capacity evicts
  // the least-recently-used session. Persistent state lives in MySQL, so an
  // evicted session is transparently rebuilt from the DB on the next message.
  sessionIdleTtlMs: parseInt(env("SESSION_IDLE_TTL_MS", String(30 * 60 * 1000)), 10),
  sessionCacheCapacity: parseInt(env("SESSION_CACHE_CAPACITY", "20"), 10),
  sessionSweepIntervalMs: parseInt(env("SESSION_SWEEP_INTERVAL_MS", String(5 * 60 * 1000)), 10),

  // Default thinking level for all agents. Set DEFAULT_THINKING_LEVEL in .env
  // to override. Valid values: off, minimal, low, medium, high, xhigh.
  defaultThinkingLevel: env("DEFAULT_THINKING_LEVEL", "high") as "off" | "minimal" | "low" | "medium" | "high" | "xhigh",
  // Context window limit: sessions at or above this percentage are
  // blocked from further input (default: 100%).
  contextLimitPercent: parseInt(env("CONTEXT_LIMIT_PERCENT", "100"), 10),
};
