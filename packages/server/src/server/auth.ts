import { timingSafeEqual } from "node:crypto";
import type { RequestHandler } from "express";

export interface DaemonAuthConfig {
  password?: string;
}

interface BearerValidationInput {
  password: string | undefined;
  token: string | null;
}

export function isBearerTokenValid(input: BearerValidationInput): boolean {
  if (!input.password) {
    return true;
  }
  if (input.token === null) {
    return false;
  }

  const expected = Buffer.from(input.password, "utf8");
  const actual = Buffer.from(input.token, "utf8");
  if (actual.length !== expected.length) {
    timingSafeEqual(expected, Buffer.alloc(expected.length));
    return false;
  }
  return timingSafeEqual(actual, expected);
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

export function createRequireBearerMiddleware(auth: DaemonAuthConfig | undefined): RequestHandler {
  const password = auth?.password;
  return (req, res, next) => {
    if (!password || shouldBypassBearerAuth(req.method, req.path)) {
      next();
      return;
    }

    const token = extractHttpBearerToken(req.header("authorization"));
    if (!isBearerTokenValid({ password, token })) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    next();
  };
}

export function shouldBypassBearerAuth(method: string, path: string): boolean {
  if (method === "OPTIONS") {
    return true;
  }
  // Public liveness/version endpoints used by local supervisors and health probes.
  return path === "/api/health" || path === "/api/status";
}
