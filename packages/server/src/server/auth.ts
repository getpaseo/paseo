import { compare, compareSync, hashSync } from "bcryptjs";
import { timingSafeEqual } from "node:crypto";
import type { RequestHandler } from "express";

export const DAEMON_PASSWORD_BCRYPT_COST = 12;

export interface DaemonAuthConfig {
  password?: string;
}

export interface BearerAuthRejectContext {
  path: string;
  method: string;
  hasToken: boolean;
}

interface BearerValidationInput {
  password: string | undefined;
  token: string | null;
}

export function isBearerTokenValid(input: BearerValidationInput): boolean {
  return isBearerTokenValidSync(input);
}

export async function isBearerTokenValidAsync(input: BearerValidationInput): Promise<boolean> {
  if (!input.password) {
    return true;
  }
  if (input.token === null) {
    return false;
  }

  return compare(input.token, input.password);
}

export function isBearerTokenValidSync(input: BearerValidationInput): boolean {
  if (!input.password) {
    return true;
  }
  if (input.token === null) {
    return false;
  }

  return compareSync(input.token, input.password);
}

export function hashDaemonPassword(password: string): string {
  return hashSync(password, DAEMON_PASSWORD_BCRYPT_COST);
}

export function extractHttpBearerToken(value: string | undefined): string | null {
  if (!value) {
    return null;
  }
  const [scheme, ...tokenParts] = value.trim().split(/\s+/);
  if (scheme !== "Bearer" || tokenParts.length !== 1) {
    return null;
  }
  return tokenParts[0] ?? null;
}

export function extractWsBearerProtocol(value: string | undefined): string | null {
  if (!value) {
    return null;
  }

  for (const protocol of value.split(",")) {
    const trimmed = protocol.trim();
    const segments = trimmed.split(".");
    if (segments[0] === "paseo" && segments[1] === "bearer" && segments.length >= 3) {
      return trimmed;
    }
  }

  return null;
}

export function extractWsBearerToken(protocol: string | null): string | null {
  if (!protocol) {
    return null;
  }
  const segments = protocol.split(".");
  if (segments[0] !== "paseo" || segments[1] !== "bearer" || segments.length < 3) {
    return null;
  }
  return segments.slice(2).join(".");
}

export function createRequireBearerMiddleware(
  auth: DaemonAuthConfig | undefined,
  onReject?: (context: BearerAuthRejectContext) => void,
): RequestHandler {
  const password = auth?.password;
  return (req, res, next) => {
    if (!password || shouldBypassBearerAuth(req.method, req.path)) {
      next();
      return;
    }

    void (async () => {
      try {
        const token = extractHttpBearerToken(req.header("authorization"));
        if (!(await isBearerTokenValidAsync({ password, token }))) {
          onReject?.({
            path: req.path,
            method: req.method,
            hasToken: token !== null,
          });
          res.status(401).json({ error: "Unauthorized" });
          return;
        }

        next();
      } catch (error) {
        next(error);
      }
    })();
  };
}

// Routes that authenticate via their own capability and therefore must not be
// gated a second time behind the daemon password.
const BEARER_AUTH_BYPASS_PATHS = new Set([
  // Unauthenticated liveness probe.
  "/api/health",
  // Guarded by a single-use download token (crypto-random UUID, 60s TTL,
  // consumed on first use) that is only ever issued over the
  // already-authenticated WebSocket. The token IS the capability for this
  // route. Requiring the daemon password on top of it breaks browser and
  // Electron downloads: those trigger the download via an anchor navigation,
  // which cannot attach an `Authorization` header. The download endpoint still
  // rejects requests without a valid token (400/403), so dropping the bearer
  // here does not make the route unauthenticated.
  "/api/files/download",
  // The daemon injects its own agents' Paseo MCP connections at this endpoint
  // (and connects its own per-client MCP client here). Those connections cannot
  // carry the daemon password — it is only known in plaintext when set via env,
  // never when set via the app — so the route authenticates them with a
  // per-daemon-run capability token instead (see isAgentMcpRequestAuthorized).
  // The token is injected only into local agent configs/sessions and never sent
  // to remote clients, and the route still rejects callers presenting neither
  // the token nor a valid daemon password, so dropping the global bearer here
  // does not make the endpoint unauthenticated.
  "/mcp/agents",
]);

export function shouldBypassBearerAuth(method: string, path: string): boolean {
  if (method === "OPTIONS") {
    return true;
  }
  return BEARER_AUTH_BYPASS_PATHS.has(path);
}

/**
 * Authorizes a request to the Agent MCP endpoint (/mcp/agents), which is exempt
 * from the global daemon-password middleware. Accepts either the per-daemon-run
 * capability token the daemon injects into its own agents' configs and MCP
 * client, or a valid daemon-password bearer (so existing password-authenticated
 * callers keep working). When no daemon password is configured the endpoint is
 * open, matching the global middleware's behavior.
 */
export async function isAgentMcpRequestAuthorized(input: {
  password: string | undefined;
  capabilityToken: string | null;
  authorizationHeader: string | undefined;
}): Promise<boolean> {
  if (!input.password) {
    return true;
  }
  const token = extractHttpBearerToken(input.authorizationHeader);
  if (input.capabilityToken !== null && token !== null) {
    // Constant-time compare; length-guard first because timingSafeEqual throws
    // on differing buffer lengths.
    const provided = Buffer.from(token);
    const expected = Buffer.from(input.capabilityToken);
    if (provided.length === expected.length && timingSafeEqual(provided, expected)) {
      return true;
    }
  }
  return isBearerTokenValidAsync({ password: input.password, token });
}
