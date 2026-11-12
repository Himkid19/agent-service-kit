import type { Request, Response, NextFunction } from "express";
import { authService } from "../services/auth.service.js";

export interface AuthenticatedRequest extends Request {
  user?: { sub: string; username: string };
}

export async function authRequired(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
  const header = req.headers.authorization;
  if (!header || !header.startsWith("Bearer ")) {
    res.status(401).json({ error: "Missing or invalid Authorization header" });
    return;
  }
  try {
    const user = authService.verifyToken(header.slice(7));
    const existing = await authService.getUserById(user.sub);
    if (!existing) {
      res.status(401).json({ error: "User not found" });
      return;
    }
    req.user = user;
    next();
  } catch (err) {
    res.status(401).json({ error: "Invalid or expired token" });
  }
}
