/**
 * Cross-platform fetch helper for the auth-server HTTP API.
 *
 * - Web: relies on Better Auth cookies via `credentials: "include"`.
 * - Desktop/Mobile: attaches the stored bearer session token so the auth-server
 *   can authenticate the request without a browser cookie jar.
 *
 * Both mechanisms are sent on every request — the auth-server tries Bearer
 * first and falls through to the cookie session if absent. Callers receive the
 * raw `Response` so they can handle 4xx bodies however they want.
 */

function authServerBaseUrl(): string {
  if (typeof __DEV__ !== "undefined" && __DEV__) {
    return "http://localhost:3002";
  }
  return "https://auth.hubcode.ai";
}

export interface AuthServerFetchOptions extends RequestInit {
  /** Bearer session token from useAuthSession().session?.sessionToken. */
  sessionToken?: string | null;
}

export async function authServerFetch(
  path: string,
  options: AuthServerFetchOptions = {},
): Promise<Response> {
  const { sessionToken, headers: headersInit, body, ...rest } = options;
  const url = `${authServerBaseUrl()}${path}`;
  const headers: Record<string, string> = {
    ...(body ? { "Content-Type": "application/json" } : {}),
    ...(sessionToken ? { Authorization: `Bearer ${sessionToken}` } : {}),
    ...(headersInit as Record<string, string> | undefined),
  };
  return fetch(url, {
    ...rest,
    credentials: "include",
    headers,
    body,
  });
}
