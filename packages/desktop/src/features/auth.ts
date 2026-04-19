import { createHash, randomBytes } from "node:crypto";
import { createServer, type Server, type IncomingMessage } from "node:http";
import { shell } from "electron";
import log from "electron-log/main";
import {
  saveAuthSession,
  loadAuthSession,
  clearAuthSession,
  type StoredAuthSession,
  type StoredAuthUser,
} from "./auth-store.js";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const AUTH_SERVER_URL =
  process.env.HUBCODE_AUTH_SERVER_URL?.replace(/\/$/, "") ?? "https://auth.hubcode.ai";

const LOOPBACK_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
const SESSION_DURATION_DAYS = 30;

// ---------------------------------------------------------------------------
// PKCE utilities
// ---------------------------------------------------------------------------

function generateCodeVerifier(): string {
  return randomBytes(32).toString("base64url");
}

function generateCodeChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

function generateState(): string {
  return randomBytes(32).toString("base64url");
}

// ---------------------------------------------------------------------------
// Loopback callback server
// ---------------------------------------------------------------------------

type CallbackResult = {
  code: string;
  state: string;
};

function startLoopbackServer(): Promise<{
  port: number;
  result: Promise<CallbackResult>;
  close: () => void;
}> {
  return new Promise((resolveStart, rejectStart) => {
    let server: Server;
    let settled = false;

    const resultPromise = new Promise<CallbackResult>((resolveResult, rejectResult) => {
      const timeout = setTimeout(() => {
        if (!settled) {
          settled = true;
          server?.close();
          rejectResult(new Error("Authentication timed out. Please try again."));
        }
      }, LOOPBACK_TIMEOUT_MS);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- same Node/DOM type conflict as main.ts WriteStream
      server = createServer((req: IncomingMessage, res: any) => {
        if (settled) {
          res.writeHead(400);
          res.end();
          return;
        }

        const url = new URL(req.url ?? "/", `http://127.0.0.1`);
        const code = url.searchParams.get("code");
        const state = url.searchParams.get("state");
        const error = url.searchParams.get("error");

        if (error) {
          settled = true;
          clearTimeout(timeout);
          res.writeHead(200, { "Content-Type": "text/html" });
          res.end(errorHtml(error));
          server.close();
          rejectResult(new Error(`Authentication error: ${error}`));
          return;
        }

        if (!code || !state) {
          res.writeHead(400, { "Content-Type": "text/html" });
          res.end(errorHtml("Missing code or state parameter."));
          return;
        }

        settled = true;
        clearTimeout(timeout);

        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(successHtml());
        server.close();

        resolveResult({ code, state });
      });

      server.on("error", (err) => {
        if (!settled) {
          settled = true;
          clearTimeout(timeout);
          rejectResult(err);
        }
      });

      server.listen(0, "127.0.0.1", () => {
        const addr = server.address();
        if (!addr || typeof addr === "string") {
          rejectStart(new Error("Failed to start loopback server."));
          return;
        }
        resolveStart({
          port: addr.port,
          result: resultPromise,
          close: () => {
            settled = true;
            server.close();
          },
        });
      });
    });
  });
}

function successHtml(): string {
  return `<!DOCTYPE html>
<html>
<head>
  <title>Signed in</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, sans-serif; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; background: #0a0a0a; color: #e5e5e5; }
    .card { text-align: center; }
    h1 { font-size: 1.5rem; margin-bottom: 0.5rem; }
    p { color: #999; }
  </style>
</head>
<body>
  <div class="card">
    <h1>Signed in successfully</h1>
    <p>You can close this tab and return to Hubcode.</p>
  </div>
</body>
</html>`;
}

function errorHtml(message: string): string {
  const escaped = message.replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return `<!DOCTYPE html>
<html>
<head>
  <title>Authentication error</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, sans-serif; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; background: #0a0a0a; color: #e5e5e5; }
    .card { text-align: center; }
    h1 { font-size: 1.5rem; margin-bottom: 0.5rem; color: #ef4444; }
    p { color: #999; }
  </style>
</head>
<body>
  <div class="card">
    <h1>Authentication failed</h1>
    <p>${escaped}</p>
  </div>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Authenticated fetch helper
// ---------------------------------------------------------------------------

async function authFetch(path: string, options: RequestInit = {}): Promise<Response> {
  const session = loadAuthSession();
  if (!session) {
    throw new Error("Not authenticated. Please sign in first.");
  }

  const url = `${AUTH_SERVER_URL}${path}`;
  const response = await fetch(url, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${session.sessionToken}`,
      ...options.headers,
    },
  });

  if (response.status === 401) {
    log.info("[auth] session expired or invalid, clearing");
    clearAuthSession();
    throw new Error("Session expired. Please sign in again.");
  }

  return response;
}

// ---------------------------------------------------------------------------
// Command handlers
// ---------------------------------------------------------------------------

type DesktopCommandHandler = (args?: Record<string, unknown>) => Promise<unknown> | unknown;

async function signIn(args?: Record<string, unknown>): Promise<{
  user: StoredAuthUser;
  providerId: string;
}> {
  const providerId = args?.providerId as string | undefined;

  log.info("[auth] starting PKCE sign-in flow", { providerId: providerId ?? "user-choice" });

  const codeVerifier = generateCodeVerifier();
  const codeChallenge = generateCodeChallenge(codeVerifier);
  const state = generateState();

  const { port, result, close } = await startLoopbackServer();
  const redirectUri = `http://127.0.0.1:${port}/`;

  const signInUrl = new URL(`${AUTH_SERVER_URL}/sign-in`);
  if (providerId) {
    signInUrl.searchParams.set("provider_id", providerId);
  }
  signInUrl.searchParams.set("state", state);
  signInUrl.searchParams.set("code_challenge", codeChallenge);
  signInUrl.searchParams.set("code_challenge_method", "S256");
  signInUrl.searchParams.set("redirect_uri", redirectUri);

  log.info("[auth] opening browser for OAuth", { port });
  await shell.openExternal(signInUrl.toString());

  let callback: CallbackResult;
  try {
    callback = await result;
  } catch (error) {
    close();
    throw error;
  }

  if (callback.state !== state) {
    throw new Error("State mismatch. Possible CSRF attack.");
  }

  // Exchange authorization code for session token
  log.info("[auth] exchanging authorization code");
  const exchangeResponse = await fetch(`${AUTH_SERVER_URL}/api/v1/auth/electron/exchange`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      state: callback.state,
      code: callback.code,
      code_verifier: codeVerifier,
    }),
  });

  if (!exchangeResponse.ok) {
    const body = await exchangeResponse.json().catch(() => ({}));
    throw new Error((body as { error?: string }).error ?? "Token exchange failed.");
  }

  const exchangeData = (await exchangeResponse.json()) as {
    sessionToken: string;
    accessToken: string;
    providerId: string;
    user: StoredAuthUser;
  };

  const expiresAt = new Date(
    Date.now() + SESSION_DURATION_DAYS * 24 * 60 * 60 * 1000,
  ).toISOString();

  saveAuthSession({
    sessionToken: exchangeData.sessionToken,
    user: exchangeData.user,
    providerId: exchangeData.providerId,
    expiresAt,
  });

  log.info("[auth] sign-in complete", {
    userId: exchangeData.user.userId,
    providerId: exchangeData.providerId,
  });

  return {
    user: exchangeData.user,
    providerId: exchangeData.providerId,
  };
}

function signOut(): { success: true } {
  log.info("[auth] signing out");
  clearAuthSession();
  return { success: true };
}

function getSession(): StoredAuthSession | null {
  return loadAuthSession();
}

async function getOrganizations(): Promise<unknown> {
  const response = await authFetch("/api/organizations");
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error((body as { error?: string }).error ?? "Failed to fetch organizations.");
  }
  return await response.json();
}

async function createOrganization(args?: Record<string, unknown>): Promise<unknown> {
  const name = args?.name as string;
  const slug = args?.slug as string;
  const logo = typeof args?.logo === "string" ? (args.logo as string) : undefined;

  if (!name || !slug) {
    throw new Error("Name and slug are required.");
  }

  const response = await authFetch("/api/organizations", {
    method: "POST",
    body: JSON.stringify({ name, slug, ...(logo ? { logo } : {}) }),
  });

  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error((body as { error?: string }).error ?? "Failed to create organization.");
  }
  return await response.json();
}

async function getOrgMembers(args?: Record<string, unknown>): Promise<unknown> {
  const orgId = args?.orgId as string;
  if (!orgId) {
    throw new Error("Organization ID is required.");
  }

  const response = await authFetch(`/api/organizations/${encodeURIComponent(orgId)}/members`);
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error((body as { error?: string }).error ?? "Failed to fetch members.");
  }
  return await response.json();
}

async function inviteMember(args?: Record<string, unknown>): Promise<unknown> {
  const orgId = args?.orgId as string;
  const email = args?.email as string;
  const role = (args?.role as string) ?? "member";

  if (!orgId || !email) {
    throw new Error("Organization ID and email are required.");
  }

  const response = await authFetch(`/api/organizations/${encodeURIComponent(orgId)}/members`, {
    method: "POST",
    body: JSON.stringify({ email, role }),
  });

  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error((body as { error?: string }).error ?? "Failed to invite member.");
  }
  return await response.json();
}

async function removeMember(args?: Record<string, unknown>): Promise<unknown> {
  const orgId = args?.orgId as string;
  const memberId = args?.memberId as string;

  if (!orgId || !memberId) {
    throw new Error("Organization ID and member ID are required.");
  }

  const response = await authFetch(
    `/api/organizations/${encodeURIComponent(orgId)}/members/${encodeURIComponent(memberId)}`,
    { method: "DELETE" },
  );

  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error((body as { error?: string }).error ?? "Failed to remove member.");
  }
  return await response.json();
}

async function cancelInvitation(args?: Record<string, unknown>): Promise<unknown> {
  const orgId = args?.orgId as string;
  const invitationId = args?.invitationId as string;

  if (!orgId || !invitationId) {
    throw new Error("Organization ID and invitation ID are required.");
  }

  const response = await authFetch(
    `/api/organizations/${encodeURIComponent(orgId)}/invitations/${encodeURIComponent(invitationId)}`,
    { method: "DELETE" },
  );

  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error((body as { error?: string }).error ?? "Failed to cancel invitation.");
  }
  return await response.json();
}

async function resendInvitation(args?: Record<string, unknown>): Promise<unknown> {
  const orgId = args?.orgId as string;
  const invitationId = args?.invitationId as string;

  if (!orgId || !invitationId) {
    throw new Error("Organization ID and invitation ID are required.");
  }

  const response = await authFetch(
    `/api/organizations/${encodeURIComponent(orgId)}/invitations/${encodeURIComponent(invitationId)}`,
    { method: "POST" },
  );

  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error((body as { error?: string }).error ?? "Failed to resend invitation.");
  }
  return await response.json();
}

async function readErrorDetail(response: Response, fallback: string): Promise<string> {
  const text = await response.text().catch(() => "");
  if (!text) {
    return `${fallback} (${response.status}) — empty response; restart the auth-server so Drizzle re-imports schema.ts`;
  }
  try {
    const body = JSON.parse(text) as { error?: string };
    if (body.error) return `${fallback} (${response.status}): ${body.error}`;
  } catch {
    // fall through to raw text
  }
  return `${fallback} (${response.status}): ${text.slice(0, 300)}`;
}

async function createWorkspaceShare(args?: Record<string, unknown>): Promise<unknown> {
  const response = await authFetch("/api/workspaces/share", {
    method: "POST",
    body: JSON.stringify(args),
  });

  if (!response.ok) {
    throw new Error(await readErrorDetail(response, "Failed to share workspace"));
  }
  return await response.json();
}

async function updateWorkspaceShare(args?: Record<string, unknown>): Promise<unknown> {
  const token = args?.token as string;
  if (!token) throw new Error("Token is required.");

  const { token: _omitToken, ...rest } = args ?? {};
  void _omitToken;

  const response = await authFetch(`/api/workspaces/share/${encodeURIComponent(token)}`, {
    method: "PATCH",
    body: JSON.stringify(rest),
  });

  if (!response.ok) {
    throw new Error(await readErrorDetail(response, "Failed to update workspace share"));
  }
  return await response.json();
}

async function revokeWorkspaceShare(args?: Record<string, unknown>): Promise<unknown> {
  const token = args?.token as string;
  if (!token) throw new Error("Token is required.");

  const response = await authFetch(`/api/workspaces/share/${encodeURIComponent(token)}`, {
    method: "DELETE",
  });

  if (!response.ok) {
    throw new Error(await readErrorDetail(response, "Failed to revoke workspace share"));
  }
  return await response.json();
}

async function listWorkspaceShares(args?: Record<string, unknown>): Promise<unknown> {
  const orgId = args?.orgId as string;
  if (!orgId) throw new Error("orgId is required.");

  const response = await authFetch(`/api/workspaces/share?orgId=${encodeURIComponent(orgId)}`);

  if (!response.ok) {
    throw new Error(await readErrorDetail(response, "Failed to list workspace shares"));
  }
  return await response.json();
}

async function listSharedWithMe(args?: Record<string, unknown>): Promise<unknown> {
  const orgId = args?.orgId as string;
  if (!orgId) throw new Error("orgId is required.");

  const response = await authFetch(
    `/api/workspaces/shared-with-me?orgId=${encodeURIComponent(orgId)}`,
  );

  if (!response.ok) {
    throw new Error(await readErrorDetail(response, "Failed to list shared workspaces"));
  }
  return await response.json();
}

// ---------------------------------------------------------------------------
// Export command handlers map
// ---------------------------------------------------------------------------

export function createAuthCommandHandlers(): Record<string, DesktopCommandHandler> {
  return {
    desktop_auth_sign_in: (args) => signIn(args),
    desktop_auth_sign_out: () => signOut(),
    desktop_auth_get_session: () => getSession(),
    desktop_auth_get_organizations: () => getOrganizations(),
    desktop_auth_create_organization: (args) => createOrganization(args),
    desktop_auth_get_org_members: (args) => getOrgMembers(args),
    desktop_auth_invite_member: (args) => inviteMember(args),
    desktop_auth_remove_member: (args) => removeMember(args),
    desktop_auth_cancel_invitation: (args) => cancelInvitation(args),
    desktop_auth_resend_invitation: (args) => resendInvitation(args),
    desktop_auth_create_workspace_share: (args) => createWorkspaceShare(args),
    desktop_auth_update_workspace_share: (args) => updateWorkspaceShare(args),
    desktop_auth_revoke_workspace_share: (args) => revokeWorkspaceShare(args),
    desktop_auth_list_workspace_shares: (args) => listWorkspaceShares(args),
    desktop_auth_list_shared_with_me: (args) => listSharedWithMe(args),
  };
}
