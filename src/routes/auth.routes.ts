import { Router } from "express";
import { authService } from "../services/auth.service.js";
import { loginGuard } from "../services/login-guard.js";
import { HttpError } from "../middleware/error.js";
import { createLogger } from "../logger.js";

const log = createLogger("auth");

const router = Router();

router.post("/register", async (req, res, next) => {
  try {
    const { username, password, displayName } = req.body;
    const user = await authService.register(username, password, displayName);
    log.info(`register success ip=${req.ip} username=${username}`);
    res.status(201).json(user);
  } catch (e) {
    next(e);
  }
});

router.post("/login", async (req, res, next) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) {
      throw new HttpError(400, "username and password required");
    }
    const ip = req.ip ?? "unknown";
    if (loginGuard.isLocked(ip, username)) {
      const retryAfterMs = loginGuard.lockRemainingMs(ip, username);
      log.warn(`login blocked by lockout ip=${ip} username=${username}`);
      res.status(423).json({
        error: "Too many failed login attempts. Account temporarily locked.",
        code: "ACCOUNT_LOCKED",
        retryAfterMs,
      });
      return;
    }
    const result = await authService.login(username, password);
    loginGuard.reset(ip, username);
    log.info(`login success ip=${ip} username=${username}`);
    res.json(result);
  } catch (e) {
    const ip = req.ip ?? "unknown";
    const username = typeof req.body?.username === "string" ? req.body.username : "?";
    if (e instanceof HttpError && e.message === "Invalid credentials") {
      loginGuard.recordFailure(ip, username);
      log.warn(`login failed ip=${ip} username=${username}`);
    }
    next(e);
  }
});

export default router;
