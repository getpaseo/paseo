import { compare, compareSync, hashSync } from "bcryptjs";
import { timingSafeEqual } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";
import type { RequestHandler } from "express";

export const DAEMON_PASSWORD_BCRYPT_COST = 12;

export interface DaemonAuthConfig {
  password?: string;
  /**
   * Lets connections from this machine skip the password. Config-file only, and
   * deliberately so: it punches a hole in the daemon's only authentication, so
   * an environment variable or CLI flag could turn it on somewhere the operator
   * never looks. See isLoopbackConnection for what counts as "this machine".
   */
  allowLoopbackWithoutPassword?: boolean;
}

export interface ConnectionOrigin {
  /** The kernel-reported peer address. Undefined for a Unix socket peer. */
  remoteAddress: string | undefined;
  headers: IncomingHttpHeaders | undefined;
}

const LOOPBACK_IPV6_ADDRESSES = new Set(["::1", "0:0:0:0:0:0:0:1"]);
const FORWARDING_HEADERS = ["forwarded", "x-forwarded-for", "x-real-ip"] as const;

export function isLoopbackAddress(address: string): boolean {
  const normalized = address.trim().toLowerCase();
  if (LOOPBACK_IPV6_ADDRESSES.has(normalized)) {
    return true;
  }
  const ipv4 = normalized.startsWith("::ffff:") ? normalized.slice("::ffff:".length) : normalized;
  return ipv4.startsWith("127.");
}

/**
 * True when the peer is a process on this machine: a loopback TCP address, or a
 * Unix socket, which has no peer address and is guarded by file permissions.
 *
 * Requests carrying a forwarding header are treated as remote even when the
 * socket is loopback, because a reverse proxy on the same host relays the whole
 * internet from 127.0.0.1. `req.ip` is deliberately not used here: it honours
 * the `trust proxy` setting, so a daemon configured to trust every proxy would
 * accept `X-Forwarded-For: 127.0.0.1` from anyone.
 */
export function isLoopbackConnection(origin: ConnectionOrigin): boolean {
  const headers = origin.headers;
  if (headers && FORWARDING_HEADERS.some((header) => headers[header] !== undefined)) {
    return false;
  }
  return origin.remoteAddress === undefined || isLoopbackAddress(origin.remoteAddress);
}

export function isLoopbackPasswordExempt(
  auth: DaemonAuthConfig | undefined,
  origin: ConnectionOrigin,
): boolean {
  return auth?.allowLoopbackWithoutPassword === true && isLoopbackConnection(origin);
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

    if (
      isLoopbackPasswordExempt(auth, {
        remoteAddress: req.socket.remoteAddress,
        headers: req.headers,
      })
    ) {
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

const SELF_AUTHENTICATING_ROUTES = new Set(["/api/files/download", "/mcp/agents"]);

function isBearerFreeRoute(path: string): boolean {
  return path === "/api/health" || SELF_AUTHENTICATING_ROUTES.has(path);
}

export function shouldBypassBearerAuth(method: string, path: string): boolean {
  if (method === "OPTIONS") {
    return true;
  }
  return isBearerFreeRoute(path);
}

/**
 * Authorizes a request to the Agent MCP endpoint (/mcp/agents), which is exempt
 * from the global daemon-password middleware. Accepts either the per-daemon-run
 * capability token the daemon injects into its own agents' configs and MCP
 * client, or a valid daemon-password bearer (so existing password-authenticated
 * callers keep working). When no daemon password is configured the endpoint is
 * open, matching the global middleware's behavior, as is a loopback caller once
 * the password is exempt for loopback.
 */
export async function isAgentMcpRequestAuthorized(input: {
  password: string | undefined;
  capabilityToken: string | null;
  authorizationHeader: string | undefined;
  loopbackExempt?: boolean;
}): Promise<boolean> {
  if (!input.password || input.loopbackExempt) {
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
