import express from "express";
import type { Request, Response, NextFunction } from "express";
import cors from "cors";
import swaggerUi from "swagger-ui-express";
import { randomUUID } from "node:crypto";
import { errorHandler } from "./middleware/error.js";
import authRoutes from "./routes/auth.routes.js";
import agentRoutes from "./routes/agent.routes.js";
import chatRoutes from "./routes/chat.routes.js";
import modelRoutes from "./routes/model.routes.js";
import { openApiDocument } from "./openapi.js";
import { db } from "./db.js";
import { healthService } from "./services/health.service.js";
import { chatService } from "./services/chat.service.js";
import { createLogger } from "./logger.js";

const log = createLogger("http");

/** Requests slower than this get logged at warn level. */
const SLOW_REQUEST_MS = 5000;

export function createApp(): express.Application {
  const app = express();

  app.use(cors());
  app.use(express.json());
  // JSON body parse error handler — capture the raw body so we can diagnose malformed client payloads.
  app.use((err: any, req: Request, res: Response, next: NextFunction) => {
    if (err instanceof SyntaxError && "body" in err) {
      const raw = typeof err.body === "string" ? err.body.slice(0, 2000) : undefined;
      log.warn("Malformed JSON request body", { url: req.originalUrl, ip: req.ip, body: raw, detail: err.message });
      res.status(400).json({ error: "Invalid JSON in request body", detail: err.message });
      return;
    }
    next(err);
  });

  // Request logger: assigns a request id, logs completion with duration and
  // client info. Slow requests and 5xx responses are logged at warn level so
  // they stand out from normal traffic.
  app.use((req: Request, res: Response, next: NextFunction) => {
    const start = Date.now();
    const requestId = randomUUID().slice(0, 8);
    res.setHeader("X-Request-Id", requestId);
    res.on("finish", () => {
      const durationMs = Date.now() - start;
      const line = `${req.method} ${req.originalUrl} -> ${res.statusCode} ${durationMs}ms`;
      const meta = { requestId, ip: req.ip, contentLength: res.getHeader("content-length") };
      if (res.statusCode >= 500 || durationMs >= SLOW_REQUEST_MS) {
        log.warn(line, meta);
      } else {
        log.info(line, meta);
      }
    });
    next();
  });

  // Swagger UI — public, no auth. Raw spec JSON served at /api/docs/openapi.json
  // (registered before swaggerUi.serve so it isn't swallowed by the UI handler).
  app.get("/api/docs/openapi.json", (_req: Request, res: Response) => {
    res.json(openApiDocument);
  });
  app.use(
    "/api/docs",
    swaggerUi.serve,
    swaggerUi.setup(openApiDocument, {
          customSiteTitle: "Agent Service Kit API",
    }),
  );

  // Routes
  app.use("/api/auth", authRoutes);
  app.use("/api/agents", agentRoutes);
  app.use("/api/chat", chatRoutes);
  app.use("/api/models", modelRoutes);

  // Liveness: process is up. No dependency checks — always 200 if reachable.
  // Includes runtime memory + session/gate stats so long-running memory growth
  // (the incident that previously took the whole server down) is observable
  // from plain health polling instead of needing shell access after the fact.
  app.get("/api/health", (_req, res) => {
    const mem = process.memoryUsage();
    const chatStats = chatService.stats();
    res.json({
      status: "ok",
      version: "0.1.0",
      uptimeSec: Math.round(process.uptime()),
      timestamp: new Date().toISOString(),
      memory: {
        rssBytes: mem.rss,
        heapUsedBytes: mem.heapUsed,
        heapTotalBytes: mem.heapTotal,
        externalBytes: mem.external,
      },
      sessions: chatStats.sessions,
      llmGate: chatStats.llmGate,
    });
  });

  // Readiness: verifies the DB is actually reachable. Returns 503 when the
  // database ping fails so load balancers / monitors can detect a degraded
  // instance instead of only noticing 2-minute request hangs.
  app.get("/api/health/ready", async (_req, res) => {
    let dbOk = false;
    let dbLatencyMs: number | null = null;
    let dbError: string | null = null;
    try {
      dbLatencyMs = await db.ping(3000);
      dbOk = true;
    } catch (err: any) {
      dbError = err?.message ?? String(err);
    }
    const heartbeat = healthService.getStatus();
    const body = {
      status: dbOk ? "ok" : "degraded",
      version: "0.1.0",
      uptimeSec: Math.round(process.uptime()),
      timestamp: new Date().toISOString(),
      db: {
        reachable: dbOk,
        latencyMs: dbLatencyMs,
        error: dbError,
        pool: db.poolStats(),
      },
      heartbeat,
    };
    res.status(dbOk ? 200 : 503).json(body);
  });

  // Error handler (must be last)
  app.use(errorHandler);

  return app;
}
