import { invokeDesktopCommand } from "@/desktop/electron/invoke";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type DesktopAuthUser = {
  userId: string;
  username: string;
  avatarUrl: string;
  email: string;
};

export type DesktopAuthSession = {
  sessionToken: string;
  user: DesktopAuthUser;
  providerId: string;
  expiresAt: string;
};

export type DesktopOrganization = {
  id: string;
  name: string;
  slug: string;
  role: string;
  memberCount: number;
  planId: string | null;
  subscriptionStatus: string | null;
  logo: string | null;
  createdAt: string;
};

export type DesktopOrgMember = {
  id: string;
  userId: string;
  role: string;
  createdAt: string;
  user: {
    id: string;
    name: string;
    email: string;
    image: string | null;
  } | null;
};

export type DesktopInvitation = {
  id: string;
  email: string;
  role: string;
  status: string;
  expiresAt: string;
  createdAt: string;
};

// ---------------------------------------------------------------------------
// Parsing helpers
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function toStringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function parseAuthUser(raw: unknown): DesktopAuthUser | null {
  if (!isRecord(raw)) return null;
  return {
    userId: toStringOrNull(raw.userId) ?? "",
    username: toStringOrNull(raw.username) ?? "",
    avatarUrl: typeof raw.avatarUrl === "string" ? raw.avatarUrl : "",
    email: toStringOrNull(raw.email) ?? "",
  };
}

function parseAuthSession(raw: unknown): DesktopAuthSession | null {
  if (!raw || !isRecord(raw)) return null;
  const user = parseAuthUser(raw.user);
  if (!user) return null;
  return {
    sessionToken: toStringOrNull(raw.sessionToken) ?? "",
    user,
    providerId: toStringOrNull(raw.providerId) ?? "",
    expiresAt: toStringOrNull(raw.expiresAt) ?? "",
  };
}

function parseOrganization(raw: unknown): DesktopOrganization | null {
  if (!isRecord(raw)) return null;
  return {
    id: toStringOrNull(raw.id) ?? "",
    name: toStringOrNull(raw.name) ?? "",
    slug: toStringOrNull(raw.slug) ?? "",
    role: toStringOrNull(raw.role) ?? "member",
    memberCount: typeof raw.memberCount === "number" ? raw.memberCount : 0,
    planId: toStringOrNull(raw.planId),
    subscriptionStatus: toStringOrNull(raw.subscriptionStatus),
    logo: toStringOrNull(raw.logo),
    createdAt: toStringOrNull(raw.createdAt) ?? "",
  };
}

function parseOrgMember(raw: unknown): DesktopOrgMember | null {
  if (!isRecord(raw)) return null;
  const u = isRecord(raw.user)
    ? {
        id: toStringOrNull(raw.user.id) ?? "",
        name: toStringOrNull(raw.user.name) ?? "",
        email: toStringOrNull(raw.user.email) ?? "",
        image: toStringOrNull(raw.user.image),
      }
    : null;
  return {
    id: toStringOrNull(raw.id) ?? "",
    userId: toStringOrNull(raw.userId) ?? "",
    role: toStringOrNull(raw.role) ?? "member",
    createdAt: toStringOrNull(raw.createdAt) ?? "",
    user: u,
  };
}

function parseInvitation(raw: unknown): DesktopInvitation | null {
  if (!isRecord(raw)) return null;
  return {
    id: toStringOrNull(raw.id) ?? "",
    email: toStringOrNull(raw.email) ?? "",
    role: toStringOrNull(raw.role) ?? "member",
    status: toStringOrNull(raw.status) ?? "pending",
    expiresAt: toStringOrNull(raw.expiresAt) ?? "",
    createdAt: toStringOrNull(raw.createdAt) ?? "",
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function desktopAuthSignIn(
  providerId?: string,
): Promise<{ user: DesktopAuthUser; providerId: string }> {
  const args = providerId ? { providerId } : {};
  const raw = await invokeDesktopCommand<unknown>("desktop_auth_sign_in", args);
  if (!isRecord(raw)) {
    throw new Error("Unexpected sign-in response.");
  }
  const user = parseAuthUser(raw.user);
  if (!user) {
    throw new Error("Invalid user data in sign-in response.");
  }
  return { user, providerId: toStringOrNull(raw.providerId) ?? "unknown" };
}

export async function desktopAuthSignOut(): Promise<void> {
  await invokeDesktopCommand("desktop_auth_sign_out");
}

export async function desktopAuthGetSession(): Promise<DesktopAuthSession | null> {
  const raw = await invokeDesktopCommand<unknown>("desktop_auth_get_session");
  return parseAuthSession(raw);
}

export async function desktopAuthGetOrganizations(): Promise<DesktopOrganization[]> {
  const raw = await invokeDesktopCommand<unknown>("desktop_auth_get_organizations");
  if (!isRecord(raw) || !Array.isArray(raw.organizations)) {
    return [];
  }
  return raw.organizations
    .map(parseOrganization)
    .filter((org): org is DesktopOrganization => org !== null);
}

export async function desktopAuthCreateOrganization(
  name: string,
  slug: string,
): Promise<DesktopOrganization | null> {
  const raw = await invokeDesktopCommand<unknown>("desktop_auth_create_organization", {
    name,
    slug,
  });
  return parseOrganization(raw);
}

export async function desktopAuthGetOrgMembers(
  orgId: string,
): Promise<{ members: DesktopOrgMember[]; invitations: DesktopInvitation[] }> {
  const raw = await invokeDesktopCommand<unknown>("desktop_auth_get_org_members", { orgId });
  if (!isRecord(raw)) {
    return { members: [], invitations: [] };
  }
  const members = Array.isArray(raw.members)
    ? raw.members.map(parseOrgMember).filter((m): m is DesktopOrgMember => m !== null)
    : [];
  const invitations = Array.isArray(raw.invitations)
    ? raw.invitations.map(parseInvitation).filter((i): i is DesktopInvitation => i !== null)
    : [];
  return { members, invitations };
}

export async function desktopAuthInviteMember(
  orgId: string,
  email: string,
  role: string = "member",
): Promise<unknown> {
  return await invokeDesktopCommand("desktop_auth_invite_member", { orgId, email, role });
}

export async function desktopAuthRemoveMember(orgId: string, memberId: string): Promise<unknown> {
  return await invokeDesktopCommand("desktop_auth_remove_member", { orgId, memberId });
}

export async function desktopAuthCancelInvitation(
  orgId: string,
  invitationId: string,
): Promise<unknown> {
  return await invokeDesktopCommand("desktop_auth_cancel_invitation", { orgId, invitationId });
}

export async function desktopAuthResendInvitation(
  orgId: string,
  invitationId: string,
): Promise<unknown> {
  return await invokeDesktopCommand("desktop_auth_resend_invitation", { orgId, invitationId });
}
