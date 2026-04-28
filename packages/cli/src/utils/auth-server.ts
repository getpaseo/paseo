/**
 * Auth-server fetch helper for the CLI. The CLI doesn't share the desktop's
 * encrypted token store, so we expect callers to provide credentials via env:
 *
 *   HUBCODE_AUTH_TOKEN=<session token>           (required for /api/library/*)
 *   HUBCODE_AUTH_SERVER_URL=https://auth.hubcode.ai  (default)
 *
 * Throws a `CommandError`-shaped object so the `withOutput` wrapper renders a
 * clean error instead of a raw stack trace.
 */

const DEFAULT_AUTH_SERVER_URL = "https://auth.hubcode.ai";

export function getAuthServerUrl(): string {
  return (process.env.HUBCODE_AUTH_SERVER_URL ?? DEFAULT_AUTH_SERVER_URL).replace(/\/$/, "");
}

export function getAuthToken(): string {
  const token = process.env.HUBCODE_AUTH_TOKEN?.trim();
  if (!token) {
    throw {
      code: "AUTH_REQUIRED",
      message: "Missing HUBCODE_AUTH_TOKEN",
      details:
        "Set HUBCODE_AUTH_TOKEN to a valid session token. " +
        "You can copy it from the Hubcode desktop app (Settings → Account → Copy session token).",
    };
  }
  return token;
}

export interface AuthServerRequest {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;
  body?: unknown;
  /** Override the env token; rare. */
  token?: string;
}

export async function authServerRequest<T>(req: AuthServerRequest): Promise<T> {
  const token = req.token ?? getAuthToken();
  const url = `${getAuthServerUrl()}${req.path}`;
  const headers: Record<string, string> = {
    Accept: "application/json",
    Authorization: `Bearer ${token}`,
  };
  if (req.body !== undefined) headers["Content-Type"] = "application/json";

  const res = await fetch(url, {
    method: req.method ?? "GET",
    headers,
    body: req.body !== undefined ? JSON.stringify(req.body) : undefined,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    let message = `HTTP ${res.status}`;
    let code = "AUTH_SERVER_ERROR";
    try {
      const json = JSON.parse(text) as { error?: string; code?: string };
      if (json.error) message = json.error;
      if (json.code) code = json.code.toUpperCase();
    } catch {
      if (text) message = text;
    }
    throw { code, message, details: `${req.method ?? "GET"} ${req.path}` };
  }

  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}
