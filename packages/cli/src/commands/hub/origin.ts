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

function invalidHubOrigin(): HubCommandError {
  return new HubCommandError(
    "HUB_INVALID_ORIGIN",
    "Hub URL must be an HTTP or HTTPS origin without credentials, path, query, or hash.",
  );
}
