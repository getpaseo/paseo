/**
 * Web/mobile fallback for the auth-server HTTP API. The desktop app uses an
 * Electron bridge (invokeDesktopCommand) that already bundles the user's
 * bearer token; browsers instead authenticate via Better Auth cookies on the
 * auth-server origin, so every fetch here sends `credentials: "include"` and
 * relies on cross-site cookies being allowed by the auth-server.
 */

import type {
  DesktopAuthSession,
  DesktopOrganization,
  DesktopOrgMember,
  DesktopInvitation,
  WorkspaceShareRecord,
  SharedWorkspaceRecord,
  WorkspaceShareAccessLevel,
  WorkspaceShareCreateResult,
  DesktopCreateWorkspaceShareParams,
  DesktopUpdateWorkspaceShareParams,
} from "./desktop-auth";

export function authServerBaseUrl(): string {
  // Dev auth-server runs on 3002; prod lives at auth.hubcode.ai.
  if (typeof __DEV__ !== "undefined" && __DEV__) {
    return "http://localhost:3002";
  }
  return "https://auth.hubcode.ai";
}

async function webFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const url = `${authServerBaseUrl()}${path}`;
  return fetch(url, {
    ...init,
    credentials: "include",
    headers: {
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...(init.headers ?? {}),
    },
  });
}

/**
 * Web sign-in: redirect the browser to the auth-server's sign-in page. The
 * OAuth provider finishes the flow there, sets the Better Auth cookie, and
 * redirects back to the current app URL. Session then populates via
 * `webGetSession` on the next mount/refresh.
 */
export function webSignIn(): void {
  if (typeof window === "undefined") return;
  const returnTo = encodeURIComponent(window.location.href);
  window.location.href = `${authServerBaseUrl()}/sign-in?redirect=${returnTo}`;
}

/**
 * Web sign-out: calls Better Auth's sign-out endpoint to clear the server-
 * side session + cookie, then returns. Callers should invalidate their
 * session cache afterwards.
 */
export async function webSignOut(): Promise<void> {
  try {
    await webFetch("/api/auth/sign-out", { method: "POST" });
  } catch {
    // Network failure still counts as "signed out" locally — let callers wipe
    // their cache regardless.
  }
}

function toAccessLevel(v: unknown): WorkspaceShareAccessLevel {
  return v === "full_access" ? "full_access" : "read_only";
}

export async function webGetSession(): Promise<DesktopAuthSession | null> {
  try {
    const res = await webFetch("/api/auth/get-session");
    if (!res.ok) return null;
    const body = (await res.json()) as {
      session?: {
        id?: string;
        userId?: string;
        token?: string;
        expiresAt?: string;
      };
      user?: {
        id: string;
        name: string;
        email: string;
        image: string | null;
        role?: string;
      };
    };
    if (!body.user) return null;
    return {
      // Better Auth's cookie-based getSession returns the session row with
      // its `token` field. We surface it so non-cookie transports (e.g.
      // Colyseus WebSocket, which doesn't forward the HttpOnly cookie to a
      // cross-origin ws server) can still authenticate with it.
      sessionToken: body.session?.token ?? "",
      providerId: "web-cookie",
      expiresAt: body.session?.expiresAt ?? "",
      user: {
        userId: body.user.id,
        username: body.user.name,
        email: body.user.email,
        avatarUrl: body.user.image ?? "",
      },
    };
  } catch {
    return null;
  }
}

export async function webCreateOrganization(
  name: string,
  slug: string,
  logo?: string,
): Promise<DesktopOrganization | null> {
  const res = await webFetch("/api/organizations", {
    method: "POST",
    body: JSON.stringify({ name, slug, ...(logo ? { logo } : {}) }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `Failed to create organization (${res.status})`);
  }
  const body = (await res.json()) as Record<string, unknown>;
  return {
    id: String(body.id ?? ""),
    name: String(body.name ?? ""),
    slug: String(body.slug ?? ""),
    role: String(body.role ?? "owner"),
    memberCount: typeof body.memberCount === "number" ? body.memberCount : 1,
    planId: typeof body.planId === "string" ? body.planId : null,
    subscriptionStatus:
      typeof body.subscriptionStatus === "string" ? body.subscriptionStatus : null,
    logo: typeof body.logo === "string" ? body.logo : null,
    createdAt: typeof body.createdAt === "string" ? body.createdAt : "",
  };
}

export async function webUpdateOrganization(
  orgId: string,
  updates: { name?: string; slug?: string; logo?: string | null },
): Promise<DesktopOrganization | null> {
  const res = await webFetch(`/api/organizations/${encodeURIComponent(orgId)}`, {
    method: "PATCH",
    body: JSON.stringify(updates),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `Failed to update organization (${res.status})`);
  }
  const body = (await res.json()) as Record<string, unknown>;
  return {
    id: String(body.id ?? ""),
    name: String(body.name ?? ""),
    slug: String(body.slug ?? ""),
    role: "owner",
    memberCount: typeof body.memberCount === "number" ? body.memberCount : 1,
    planId: typeof body.planId === "string" ? body.planId : null,
    subscriptionStatus:
      typeof body.subscriptionStatus === "string" ? body.subscriptionStatus : null,
    logo: typeof body.logo === "string" ? body.logo : null,
    createdAt: typeof body.createdAt === "string" ? body.createdAt : "",
  };
}

export async function webGetOrganizations(): Promise<DesktopOrganization[]> {
  try {
    const res = await webFetch("/api/organizations");
    if (!res.ok) return [];
    const body = (await res.json()) as {
      organizations?: Array<{ id: string; name: string; slug: string; role?: string }>;
    };
    return (body.organizations ?? []).map((o) => {
      const raw = o as Record<string, unknown>;
      return {
        id: String(raw.id ?? ""),
        name: String(raw.name ?? ""),
        slug: String(raw.slug ?? ""),
        role: String(raw.role ?? "member"),
        memberCount: typeof raw.memberCount === "number" ? raw.memberCount : 0,
        planId: typeof raw.planId === "string" ? raw.planId : null,
        subscriptionStatus:
          typeof raw.subscriptionStatus === "string" ? raw.subscriptionStatus : null,
        logo: typeof raw.logo === "string" ? raw.logo : null,
        createdAt: typeof raw.createdAt === "string" ? raw.createdAt : "",
      };
    });
  } catch {
    return [];
  }
}

export async function webGetOrgMembers(
  orgId: string,
): Promise<{ members: DesktopOrgMember[]; invitations: DesktopInvitation[] }> {
  try {
    const res = await webFetch(`/api/organizations/${encodeURIComponent(orgId)}/members`);
    if (!res.ok) return { members: [], invitations: [] };
    const body = (await res.json()) as {
      members?: Array<Record<string, unknown>>;
      invitations?: Array<Record<string, unknown>>;
    };
    const members = (body.members ?? []).map((m): DesktopOrgMember => {
      const u = (m.user ?? null) as Record<string, unknown> | null;
      return {
        id: String(m.id ?? ""),
        userId: String(m.userId ?? ""),
        role: String(m.role ?? "member"),
        createdAt: typeof m.createdAt === "string" ? m.createdAt : String(m.createdAt ?? ""),
        user: u
          ? {
              id: String(u.id ?? ""),
              name: String(u.name ?? ""),
              email: String(u.email ?? ""),
              image: typeof u.image === "string" ? u.image : null,
            }
          : null,
      };
    });
    const invitations = (body.invitations ?? []).map(
      (i): DesktopInvitation => ({
        id: String(i.id ?? ""),
        email: String(i.email ?? ""),
        role: String(i.role ?? "member"),
        status: String(i.status ?? "pending"),
        expiresAt: typeof i.expiresAt === "string" ? i.expiresAt : String(i.expiresAt ?? ""),
        createdAt: typeof i.createdAt === "string" ? i.createdAt : String(i.createdAt ?? ""),
      }),
    );
    return { members, invitations };
  } catch {
    return { members: [], invitations: [] };
  }
}

export async function webListWorkspaceShares(orgId: string): Promise<WorkspaceShareRecord[]> {
  const res = await webFetch(`/api/workspaces/share?orgId=${encodeURIComponent(orgId)}`);
  if (!res.ok) return [];
  const body = (await res.json()) as {
    shares?: Array<Record<string, unknown>>;
  };
  return (body.shares ?? []).map((s): WorkspaceShareRecord => {
    const allowedUsers = Array.isArray(s.allowedUsers) ? (s.allowedUsers as unknown[]) : [];
    return {
      shareId: String(s.shareId ?? ""),
      token: String(s.token ?? ""),
      workspaceId: String(s.workspaceId ?? ""),
      serverId: String(s.serverId ?? ""),
      projectId: String(s.projectId ?? ""),
      projectName: String(s.projectName ?? ""),
      workspaceName: String(s.workspaceName ?? ""),
      orgId: String(s.orgId ?? ""),
      accessLevel: toAccessLevel(s.accessLevel),
      allowedUserIds: Array.isArray(s.allowedUserIds) ? (s.allowedUserIds as string[]) : [],
      allowedUsers: allowedUsers.map((u) => {
        const obj = (u ?? {}) as Record<string, unknown>;
        return {
          userId: String(obj.userId ?? ""),
          name: String(obj.name ?? ""),
          email: String(obj.email ?? ""),
          image: typeof obj.image === "string" ? obj.image : null,
        };
      }),
      expiresAt: typeof s.expiresAt === "string" ? s.expiresAt : null,
      createdAt: String(s.createdAt ?? ""),
      shareUrl: String(s.shareUrl ?? ""),
    };
  });
}

export async function webListSharedWithMe(orgId: string): Promise<SharedWorkspaceRecord[]> {
  const res = await webFetch(`/api/workspaces/shared-with-me?orgId=${encodeURIComponent(orgId)}`);
  if (!res.ok) return [];
  const body = (await res.json()) as {
    shares?: Array<Record<string, unknown>>;
  };
  return (body.shares ?? []).map((s): SharedWorkspaceRecord => {
    const owner = (s.owner ?? {}) as Record<string, unknown>;
    return {
      shareId: String(s.shareId ?? ""),
      token: String(s.token ?? ""),
      workspaceId: String(s.workspaceId ?? ""),
      serverId: String(s.serverId ?? ""),
      projectId: String(s.projectId ?? ""),
      projectName: String(s.projectName ?? ""),
      workspaceName: String(s.workspaceName ?? ""),
      orgId: String(s.orgId ?? ""),
      accessLevel: toAccessLevel(s.accessLevel),
      pairingUrl: typeof s.pairingUrl === "string" ? s.pairingUrl : null,
      owner: {
        userId: String(owner.userId ?? ""),
        name: String(owner.name ?? "Unknown"),
        email: String(owner.email ?? ""),
        image: typeof owner.image === "string" ? owner.image : null,
      },
      expiresAt: typeof s.expiresAt === "string" ? s.expiresAt : null,
      createdAt: String(s.createdAt ?? ""),
      shareUrl: String(s.shareUrl ?? ""),
    };
  });
}

export async function webCreateWorkspaceShare(
  params: DesktopCreateWorkspaceShareParams,
): Promise<WorkspaceShareCreateResult> {
  const res = await webFetch("/api/workspaces/share", {
    method: "POST",
    body: JSON.stringify(params),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `Failed to create share (${res.status})`);
  }
  const body = (await res.json()) as Record<string, unknown>;
  return {
    shareId: String(body.shareId ?? ""),
    token: String(body.token ?? ""),
    shareUrl: String(body.shareUrl ?? ""),
    accessLevel: toAccessLevel(body.accessLevel),
    expiresAt: typeof body.expiresAt === "string" ? body.expiresAt : null,
  };
}

export async function webUpdateWorkspaceShare(
  params: DesktopUpdateWorkspaceShareParams,
): Promise<void> {
  const { token, ...rest } = params;
  const res = await webFetch(`/api/workspaces/share/${encodeURIComponent(token)}`, {
    method: "PATCH",
    body: JSON.stringify(rest),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `Failed to update share (${res.status})`);
  }
}

export async function webRevokeWorkspaceShare(token: string): Promise<void> {
  const res = await webFetch(`/api/workspaces/share/${encodeURIComponent(token)}`, {
    method: "DELETE",
  });
  if (!res.ok && res.status !== 404) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `Failed to revoke share (${res.status})`);
  }
}

// ── Hubcode models (OmniRoute proxy) ────────────────────────────────────────

export interface HubcodeCombo {
  comboId: string;
  comboName: string;
}

export interface HubcodeModelsBundle {
  requiresUpgrade: boolean;
  planId: string;
  apiKey: string | null;
  baseUrl: string;
  combos: HubcodeCombo[];
}

export async function webGetHubcodeModels(
  sessionToken?: string | null,
): Promise<HubcodeModelsBundle | null> {
  try {
    const res = await webFetch("/api/me/hubcode-models", {
      headers: sessionToken ? { Authorization: `Bearer ${sessionToken}` } : {},
    });
    if (!res.ok) return null;
    const body = (await res.json()) as HubcodeModelsBundle;
    return body;
  } catch {
    return null;
  }
}
