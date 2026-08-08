import { HubCommandError } from "./error.js";

export function normalizeHubOrigin(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw invalidHubOrigin();
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    (url.protocol === "http:" && !isLoopbackHostname(url.hostname)) ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw invalidHubOrigin();
  }
  return url.origin;
}

function isLoopbackHostname(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

function invalidHubOrigin(): HubCommandError {
  return new HubCommandError(
    "HUB_INVALID_ORIGIN",
    "Hub URL must be an HTTPS origin without credentials, path, query, or hash. HTTP is allowed only for localhost, 127.0.0.1, or [::1].",
  );
}
