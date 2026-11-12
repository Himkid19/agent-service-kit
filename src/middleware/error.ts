import type { Request, Response, NextFunction } from "express";
import { createLogger } from "../logger.js";

const log = createLogger("error");

/** Error with an explicit HTTP status. Thrown by services/routes for
 *  expected client errors (validation, lockout, unsafe input, ...). */
export class HttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly code?: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export function errorHandler(err: Error, req: Request, res: Response, _next: NextFunction): void {
  if (err instanceof HttpError) {
    log.warn(`${req.method} ${req.originalUrl} -> ${err.status}`, {
      requestId: res.getHeader("X-Request-Id"),
      ip: req.ip,
      code: err.code,
      message: err.message,
    });
    res.status(err.status).json({ error: err.message, ...(err.code ? { code: err.code } : {}) });
    return;
  }
  // Full stack + request context: this is what makes a 500 diagnosable from
  // logs alone (previously only the message was printed).
  log.error(`${req.method} ${req.originalUrl} failed`, err, {
    requestId: res.getHeader("X-Request-Id"),
    ip: req.ip,
    body: (err as any).body?.slice?.(0, 2000),
  });
  const status = err.message.includes("not found") ? 404
    : err.message.includes("already exists") ? 409
    : err.message.includes("Invalid credentials") ? 401
    : err.message.includes("Register") ? 400
    : err.message.startsWith("Context window limit reached") ? 400
    : err.message.includes("LLM_CALL_QUEUE_TIMEOUT") ? 503
    : 500;
  res.status(status).json({
    error: status === 500 ? "Internal server error" : err.message,
  });
}
