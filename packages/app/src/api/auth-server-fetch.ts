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

import { resolveAuthServerUrl } from "@/utils/auth-server-url";

export function authServerBaseUrl(): string {
  return resolveAuthServerUrl();
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
  const response = await fetch(url, {
    ...rest,
    credentials: "include",
    headers,
    body,
  });
  // Self-healing: a persisted activeOrgId from a previous session can outlive
  // the user's membership (kicked, org deleted, account switched). The first
  // request to that org returns 403 "Not a member of this organization"; we
  // clear the local pin so the next render falls back to organizations[0]
  // (the Personal org guarantees one always exists post-signup) and the
  // useless 403 storm stops on its own.
  if (response.status === 403 && path.includes(getActiveOrgIdSnapshot() ?? "\0__never__\0")) {
    void clearActiveOrgIfNotAMember(response.clone());
  }
  return response;
}

async function clearActiveOrgIfNotAMember(response: Response): Promise<void> {
  try {
    const body = await response.text();
    if (body.toLowerCase().includes("not a member")) {
      const { setActiveOrgId } = await import("@/stores/active-org-store");
      setActiveOrgId(null);
    }
  } catch {
    // Body unreadable / not JSON — leave activeOrgId alone.
  }
}

// Imported lazily inside clearActiveOrgIfNotAMember to avoid a circular dep
// with the store; this top-level import is just for the snapshot read on the
// hot path (no side effects).
import { getActiveOrgIdSnapshot } from "@/stores/active-org-store";
