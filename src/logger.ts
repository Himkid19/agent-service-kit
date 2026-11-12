/** Structured leveled logger.
 *  Levels: debug < info < warn < error. Controlled by LOG_LEVEL env (default "info").
 *  Output format: 2026-07-22T08:00:00.000Z [INFO ] [scope] message ...meta
 */
export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

function resolveLevel(): LogLevel {
  const raw = (process.env.LOG_LEVEL || "info").toLowerCase();
  return raw in LEVEL_ORDER ? (raw as LogLevel) : "info";
}

let currentLevel: LogLevel = resolveLevel();

export function setLogLevel(level: LogLevel): void {
  currentLevel = level;
}

function serializeMeta(meta: unknown[]): string {
  if (meta.length === 0) return "";
  return (
    " " +
    meta
      .map((m) => {
        if (m instanceof Error) {
          return `${m.message}\n${m.stack ?? ""}`;
        }
        if (typeof m === "string") return m;
        try {
          return JSON.stringify(m);
        } catch {
          return String(m);
        }
      })
      .join(" ")
  );
}

export interface Logger {
  debug(msg: string, ...meta: unknown[]): void;
  info(msg: string, ...meta: unknown[]): void;
  warn(msg: string, ...meta: unknown[]): void;
  error(msg: string, ...meta: unknown[]): void;
}

function emit(level: LogLevel, scope: string | null, msg: string, meta: unknown[]): void {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[currentLevel]) return;
  const ts = new Date().toISOString();
  const tag = level.toUpperCase().padEnd(5);
  const prefix = scope ? `[${scope}] ` : "";
  const line = `${ts} [${tag}] ${prefix}${msg}${serializeMeta(meta)}`;
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

/** Create a scoped logger, e.g. createLogger("db") -> "[db] ..." lines. */
export function createLogger(scope: string): Logger {
  return {
    debug: (msg, ...meta) => emit("debug", scope, msg, meta),
    info: (msg, ...meta) => emit("info", scope, msg, meta),
    warn: (msg, ...meta) => emit("warn", scope, msg, meta),
    error: (msg, ...meta) => emit("error", scope, msg, meta),
  };
}

/** Root logger without a scope tag. */
export const logger: Logger = {
  debug: (msg, ...meta) => emit("debug", null, msg, meta),
  info: (msg, ...meta) => emit("info", null, msg, meta),
  warn: (msg, ...meta) => emit("warn", null, msg, meta),
  error: (msg, ...meta) => emit("error", null, msg, meta),
};
