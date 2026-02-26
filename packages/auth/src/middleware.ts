import type { Request, Response, NextFunction } from "express"
import { verifyToken, createJwtValidator } from "./jwt.js"
import type { TokenPayload } from "./types.js"

declare global {
  namespace Express {
    interface Request {
      user?: TokenPayload
    }
  }
}

/**
 * Express middleware that validates JWT from Authorization header.
 */
export function authMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const authHeader = req.headers.authorization
  if (!authHeader?.startsWith("Bearer ")) {
    res.status(401).json({ error: "Missing token" })
    return
  }

  const token = authHeader.slice(7)
  const payload = verifyToken(token)

  if (!payload) {
    res.status(401).json({ error: "Invalid or expired token" })
    return
  }

  req.user = payload
  next()
}

/**
 * Require admin role middleware. Use after authMiddleware.
 */
export function adminMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (req.user?.role !== "admin") {
    res.status(403).json({ error: "Admin access required" })
    return
  }
  next()
}

/**
 * Authenticate a WebSocket token string.
 * Returns the payload if valid, null otherwise.
 */
export function authenticateWsToken(token: string): TokenPayload | null {
  return verifyToken(token)
}

// Re-export for daemon use
export { createJwtValidator } from "./jwt.js"
export type { TokenPayload } from "./types.js"
