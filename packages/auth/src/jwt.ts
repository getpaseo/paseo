import jwt from "jsonwebtoken"
import crypto from "crypto"
import fs from "fs"
import path from "path"
import type { TokenPayload } from "./types.js"

const DEFAULT_JWT_EXPIRY = "30d"
const JWT_REFRESH_THRESHOLD = 86400 // refresh if < 1 day remaining

let jwtSecret: string | null = null

export function initJwt(secret: string): void {
  jwtSecret = secret
}

function getSecret(): string {
  if (!jwtSecret) {
    throw new Error("JWT not initialized. Call initJwt() first.")
  }
  return jwtSecret
}

export function issueToken(
  userId: string,
  username: string,
  role: "admin" | "user",
  expiry?: string,
): string {
  return jwt.sign({ sub: userId, username, role }, getSecret(), {
    expiresIn: expiry ?? DEFAULT_JWT_EXPIRY,
  } as jwt.SignOptions)
}

export function verifyToken(token: string): TokenPayload | null {
  try {
    return jwt.verify(token, getSecret()) as TokenPayload
  } catch {
    return null
  }
}

export function shouldRefreshToken(payload: TokenPayload): boolean {
  const now = Math.floor(Date.now() / 1000)
  return payload.exp - now < JWT_REFRESH_THRESHOLD
}

/**
 * Create a standalone JWT validator function.
 * Used by the daemon to validate tokens without starting the auth server.
 */
export function createJwtValidator(
  secret: string,
): (token: string) => TokenPayload | null {
  return (token: string) => {
    try {
      return jwt.verify(token, secret) as TokenPayload
    } catch {
      return null
    }
  }
}

/**
 * Load or generate the JWT secret for a Junction home directory.
 */
export function loadOrCreateJwtSecret(junctionHome: string): string {
  const secretPath = path.join(junctionHome, "auth", "jwt-secret.key")
  const dir = path.dirname(secretPath)

  if (fs.existsSync(secretPath)) {
    return fs.readFileSync(secretPath, "utf-8").trim()
  }

  fs.mkdirSync(dir, { recursive: true })
  const secret = crypto.randomBytes(64).toString("hex")
  fs.writeFileSync(secretPath, secret, { mode: 0o600 })
  return secret
}
