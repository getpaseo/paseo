import type { RequestHandler } from "express";

/**
 * Normalizes a configured URL path prefix the daemon is served under, such as
 * `/user/alice/paseo`. Returns "" for no prefix. The result always starts with
 * "/" and never ends with one, so `${basePath}/ws` is the WebSocket path.
 */
export function normalizeBasePath(input: string | null | undefined): string {
  const trimmed = input?.trim() ?? "";
  if (!trimmed || trimmed === "/") {
    return "";
  }
  if (!trimmed.startsWith("/")) {
    throw new Error(`Invalid base path "${trimmed}": must start with "/"`);
  }
  if (/[?#\\\s]/.test(trimmed)) {
    throw new Error(`Invalid base path "${trimmed}": must be a plain URL path`);
  }
  const segments = trimmed.split("/").filter((segment) => segment.length > 0);
  if (segments.some((segment) => segment === "." || segment === "..")) {
    throw new Error(`Invalid base path "${trimmed}": must not contain "." or ".." segments`);
  }
  return `/${segments.join("/")}`;
}

/**
 * Removes the base path from a request URL (path plus query). Returns null when
 * the URL is outside the base path, so the caller leaves it untouched: a
 * reverse proxy that already stripped the prefix sends unprefixed paths.
 */
export function stripBasePath(url: string, basePath: string): string | null {
  if (!basePath || !url.startsWith(basePath)) {
    return null;
  }
  const rest = url.slice(basePath.length);
  if (rest === "") {
    return "/";
  }
  if (rest.startsWith("?")) {
    return `/${rest}`;
  }
  if (rest.startsWith("/")) {
    return rest;
  }
  return null;
}

/**
 * Express middleware that serves the daemon under a base path. Prefixed
 * requests have the prefix removed before routing; unprefixed requests pass
 * through unchanged.
 */
export function createBasePathMiddleware(basePath: string): RequestHandler {
  return (req, _res, next) => {
    const stripped = stripBasePath(req.url, basePath);
    if (stripped !== null) {
      req.url = stripped;
    }
    next();
  };
}

/** True when an upgrade request targets the daemon WebSocket endpoint. */
export function isDaemonWebSocketPath(url: string | undefined, basePath: string): boolean {
  if (!url) {
    return false;
  }
  const queryIndex = url.indexOf("?");
  const pathname = queryIndex === -1 ? url : url.slice(0, queryIndex);
  return pathname === "/ws" || (basePath !== "" && pathname === `${basePath}/ws`);
}
