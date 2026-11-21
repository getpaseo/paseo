import { compare, hashSync } from "bcryptjs";
import { timingSafeEqual } from "node:crypto";
import type { RequestHandler } from "express";
import { OWNER_PERMISSIONS, type DaemonPermission } from "./authorization/index.js";
import { matchesLocalCredential } from "./local-credential.js";

export const DAEMON_PASSWORD_BCRYPT_COST = 12;

/** A named, non-owner daemon credential from `daemon.auth.credentials`. */
export interface ScopedDaemonCredential {
  name: string;
  /** bcrypt hash of the credential secret. */
  password: string;
  permissions: readonly DaemonPermission[];
  /** Agent modes this credential may not create agents in or switch agents to. */
  denyModes: readonly string[];
}

export interface DaemonAuthConfig {
  /** bcrypt hash of the owner password. */
  password?: string;
  credentials?: readonly ScopedDaemonCredential[];
  localCredential?: () => string | null;
}

/** The principal a daemon secret authenticates. */
export interface DaemonCredentialPrincipal {
  principalId: string;
  permissions: readonly DaemonPermission[];
  deniedModes?: readonly string[];
}

export const OWNER_PRINCIPAL: DaemonCredentialPrincipal = {
  principalId: "owner",
  permissions: OWNER_PERMISSIONS,
};

export function scopedCredentialPrincipalId(name: string): string {
  return `credential:${name}`;
}

/**
 * Resolves a presented secret to the owner or a scoped credential principal.
 * The owner password is checked first. Returns null when nothing matches.
 */
export async function resolveDaemonSecret(
  auth: Pick<DaemonAuthConfig, "password" | "credentials"> | undefined,
  secret: string,
): Promise<DaemonCredentialPrincipal | null> {
  if (auth?.password && (await compare(secret, auth.password))) return OWNER_PRINCIPAL;
  for (const credential of auth?.credentials ?? []) {
    if (await compare(secret, credential.password)) {
      return {
        principalId: scopedCredentialPrincipalId(credential.name),
        permissions: credential.permissions,
        ...(credential.denyModes.length > 0 ? { deniedModes: credential.denyModes } : {}),
      };
    }
  }
  return null;
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

export async function isBearerTokenValidAsync(input: BearerValidationInput): Promise<boolean> {
  if (!input.password) {
    return true;
  }
  if (input.token === null) {
    return false;
  }

  return compare(input.token, input.password);
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
        const localCredential = req.path === "/api/status" ? auth?.localCredential?.() : null;
        const isLocal =
          localCredential !== null &&
          localCredential !== undefined &&
          token !== null &&
          matchesLocalCredential(localCredential, token);
        if (!isLocal && !(await isBearerTokenValidAsync({ password, token }))) {
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
 * client, the owner password, or a scoped credential. Returns the authenticated
 * principal, or null when the request is unauthorized. When no daemon password
 * is configured the endpoint is open, matching the global middleware's behavior.
 */
export async function resolveAgentMcpRequestPrincipal(input: {
  auth: Pick<DaemonAuthConfig, "password" | "credentials"> | undefined;
  capabilityToken: string | null;
  authorizationHeader: string | undefined;
}): Promise<DaemonCredentialPrincipal | null> {
  if (!input.auth?.password) {
    return OWNER_PRINCIPAL;
  }
  const token = extractHttpBearerToken(input.authorizationHeader);
  if (token === null) return null;
  if (input.capabilityToken !== null) {
    // Constant-time compare; length-guard first because timingSafeEqual throws
    // on differing buffer lengths.
    const provided = Buffer.from(token);
    const expected = Buffer.from(input.capabilityToken);
    if (provided.length === expected.length && timingSafeEqual(provided, expected)) {
      return OWNER_PRINCIPAL;
    }
  }
  return resolveDaemonSecret(input.auth, token);
}
