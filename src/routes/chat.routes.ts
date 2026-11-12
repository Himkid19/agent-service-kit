import { Router } from "express";
import { chatService } from "../services/chat.service.js";
import { assertMessageSafe } from "../services/chat-safety.js";
import { authRequired, type AuthenticatedRequest } from "../middleware/auth.js";
import { config } from "../config.js";
import { createLogger } from "../logger.js";
const log = createLogger("chat");

const router = Router();

router.use(authRequired);

/** List the current user's sessions across all agents */
router.get("/sessions", async (req: AuthenticatedRequest, res, next) => {
  try {
    const sessions = await chatService.listSessions(req.user!.sub);
    res.json({ sessions });
  } catch (e) {
    next(e);
  }
});

/** List sessions for a specific agent */
router.get("/:agentId/sessions", async (req: AuthenticatedRequest, res, next) => {
  try {
    const sessions = await chatService.listAgentSessions(req.user!.sub, req.params.agentId);
    res.json({ sessions });
  } catch (e) {
    next(e);
  }
});

/** Send a message to an agent — resume or create a session */
router.post("/:agentId", async (req: AuthenticatedRequest, res, next) => {
  try {
    const { message, provider, model, sessionId, thinkingLevel } = req.body;
    if (!message) {
      res.status(400).json({ error: "message is required" });
      return;
    }
    // Early block (before session creation / SSE headers) so unsafe prompts
    // get a clean JSON 400 and are never sent to the model or executed.
    assertMessageSafe(message);
    const result = await chatService.sendMessage(req.user!.sub, req.params.agentId, {
      message,
      provider,
      model,
      sessionId,
      thinkingLevel,
    });
    res.json(result);
  } catch (e) {
    next(e);
  }
});

/** Stream a message via SSE — shows thinking, tool calls, text deltas */
router.post("/:agentId/stream", async (req: AuthenticatedRequest, res, next) => {
  try {
    const { message, provider, model, sessionId, thinkingLevel } = req.body;
    if (!message) {
      res.status(400).json({ error: "message is required" });
      return;
    }
    assertMessageSafe(message);

    const ac = new AbortController();

    res.status(200);
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders();

    res.on("close", () => {
      if (!res.writableEnded && !ac.signal.aborted) {
        log.info(`client disconnected mid-stream for ${req.params.agentId}`);
        ac.abort();
      }
    });

    const STREAM_TIMEOUT = config.streamTimeoutMs;
    const timer = setTimeout(() => {
      if (!ac.signal.aborted) {
        const seconds = Math.round(STREAM_TIMEOUT / 1000);
        log.warn(`stream timeout for ${req.params.agentId} after ${seconds}s`);
        send("error", { error: `Request timed out after ${seconds}s` });
        res.end();
        ac.abort();
      }
    }, STREAM_TIMEOUT);

    // Backpressure-aware SSE sender: res.write() returning false means the
    // kernel socket buffer is full. Buffer the payload and resume on "drain"
    // instead of letting pending deltas accumulate unboundedly for slow
    // clients (a slow-read client used to grow memory silently).
    const pending: string[] = [];
    let paused = false;
    const flush = () => {
      if (ac.signal.aborted || res.writableEnded) {
        pending.length = 0;
        return;
      }
      while (pending.length > 0 && !paused) {
        const payload = pending.shift()!;
        if (!res.write(payload)) {
          paused = true;
          res.once("drain", () => {
            paused = false;
            flush();
          });
        }
      }
    };
    const send = (type: string, data: unknown) => {
      if (ac.signal.aborted || res.writableEnded) return;
      pending.push(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
      flush();
    };

    try {
      log.info(`stream starting agent=${req.params.agentId} message="${message.slice(0, 50)}"`);
      const result = await chatService.streamMessage(
        req.user!.sub, req.params.agentId,
        { message, provider, model, sessionId, thinkingLevel },
        (type, data) => {
          if (type === "agent_start" || type === "agent_end" || type === "error") {
            log.debug(`stream event=${type}`);
          }
          send(type, data);
        },
        ac.signal,
      );
      clearTimeout(timer);
      log.info(`stream completed agent=${req.params.agentId} session=${result.sessionId}`);
      if (!ac.signal.aborted) {
        send("done", result);
        res.end();
      }
    } catch (err: unknown) {
      clearTimeout(timer);
      const msg = err instanceof Error ? err.message : String(err);
      log.error(`stream error for ${req.params.agentId}: ${msg}`);
      send("error", { error: msg });
      res.end();
    }
  } catch (e) {
    if (res.headersSent) {
      res.end();
    } else {
      next(e);
    }
  }
});

/** Get session message history for a specific session */
router.get("/:agentId/messages", async (req: AuthenticatedRequest, res, next) => {
  try {
    const sessionId = req.query.sessionId as string;
    if (!sessionId) {
      res.status(400).json({ error: "sessionId query parameter is required" });
      return;
    }
    const messages = await chatService.getSessionMessages(req.user!.sub, req.params.agentId, sessionId);
    res.json({ messages });
  } catch (e) {
    next(e);
  }
});

/** Create a new session (archives current, starts fresh) */
router.post("/:agentId/new", async (req: AuthenticatedRequest, res, next) => {
  try {
    const sessionId = await chatService.newSession(req.user!.sub, req.params.agentId);
    res.json({ ok: true, sessionId });
  } catch (e) {
    next(e);
  }
});

/** Reset/delete a session (or all sessions for the agent if no sessionId) */
router.post("/:agentId/reset", async (req: AuthenticatedRequest, res, next) => {
  try {
    const { sessionId } = req.body;
    const result = await chatService.resetSession(req.user!.sub, req.params.agentId, sessionId || undefined);
    if (sessionId && !result.deleted) {
      res.status(404).json({ error: "Session not found", ...result });
      return;
    }
    res.json({ ok: true, ...result });
  } catch (e) {
    next(e);
  }
});

/** Resume a specific session by ID */
router.post("/:agentId/resume", async (req: AuthenticatedRequest, res, next) => {
  try {
    const { sessionId } = req.body;
    if (!sessionId) {
      res.status(400).json({ error: "sessionId is required" });
      return;
    }
    const ok = await chatService.resumeSession(req.user!.sub, req.params.agentId, sessionId);
    if (!ok) {
      res.status(404).json({ error: "Session not found" });
      return;
    }
    res.json({ ok: true, sessionId });
  } catch (e) {
    next(e);
  }
});

export default router;
