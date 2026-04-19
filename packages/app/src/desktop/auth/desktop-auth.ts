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

export type WorkspaceShareAccessLevel = "read_only" | "full_access";

export type WorkspaceShareAllowedUser = {
  userId: string;
  name: string;
  email: string;
  image: string | null;
};

export type WorkspaceShareRecord = {
  shareId: string;
  token: string;
  workspaceId: string;
  serverId: string;
  projectId: string;
  projectName: string;
  workspaceName: string;
  orgId: string;
  accessLevel: WorkspaceShareAccessLevel;
  allowedUserIds: string[];
  allowedUsers: WorkspaceShareAllowedUser[];
  expiresAt: string | null;
  createdAt: string;
  shareUrl: string;
};

export type SharedWorkspaceRecord = {
  shareId: string;
  token: string;
  workspaceId: string;
  serverId: string;
  projectId: string;
  projectName: string;
  workspaceName: string;
  orgId: string;
  accessLevel: WorkspaceShareAccessLevel;
  pairingUrl: string | null;
  owner: {
    userId: string;
    name: string;
    email: string;
    image: string | null;
  };
  expiresAt: string | null;
  createdAt: string;
  shareUrl: string;
};

export type WorkspaceShareCreateResult = {
  shareId: string;
  token: string;
  shareUrl: string;
  accessLevel: WorkspaceShareAccessLevel;
  expiresAt: string | null;
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
  logo?: string,
): Promise<DesktopOrganization | null> {
  const raw = await invokeDesktopCommand<unknown>("desktop_auth_create_organization", {
    name,
    slug,
    ...(logo ? { logo } : {}),
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

// ---------------------------------------------------------------------------
// Workspace share parsing
// ---------------------------------------------------------------------------

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === "string");
}

function parseAllowedUser(raw: unknown): WorkspaceShareAllowedUser | null {
  if (!isRecord(raw)) return null;
  return {
    userId: toStringOrNull(raw.userId) ?? "",
    name: toStringOrNull(raw.name) ?? "Unknown",
    email: toStringOrNull(raw.email) ?? "",
    image: toStringOrNull(raw.image),
  };
}

function parseWorkspaceShareRecord(raw: unknown): WorkspaceShareRecord | null {
  if (!isRecord(raw)) return null;
  const accessLevelRaw = toStringOrNull(raw.accessLevel) ?? "read_only";
  const accessLevel: WorkspaceShareAccessLevel =
    accessLevelRaw === "full_access" ? "full_access" : "read_only";
  return {
    shareId: toStringOrNull(raw.shareId) ?? "",
    token: toStringOrNull(raw.token) ?? "",
    workspaceId: toStringOrNull(raw.workspaceId) ?? "",
    serverId: toStringOrNull(raw.serverId) ?? "",
    projectId: toStringOrNull(raw.projectId) ?? "",
    projectName: toStringOrNull(raw.projectName) ?? "",
    workspaceName: toStringOrNull(raw.workspaceName) ?? "",
    orgId: toStringOrNull(raw.orgId) ?? "",
    accessLevel,
    allowedUserIds: toStringArray(raw.allowedUserIds),
    allowedUsers: Array.isArray(raw.allowedUsers)
      ? raw.allowedUsers
          .map(parseAllowedUser)
          .filter((u): u is WorkspaceShareAllowedUser => u !== null)
      : [],
    expiresAt: toStringOrNull(raw.expiresAt),
    createdAt: toStringOrNull(raw.createdAt) ?? "",
    shareUrl: toStringOrNull(raw.shareUrl) ?? "",
  };
}

function parseSharedWorkspaceRecord(raw: unknown): SharedWorkspaceRecord | null {
  if (!isRecord(raw)) return null;
  const accessLevelRaw = toStringOrNull(raw.accessLevel) ?? "read_only";
  const accessLevel: WorkspaceShareAccessLevel =
    accessLevelRaw === "full_access" ? "full_access" : "read_only";
  const owner = isRecord(raw.owner)
    ? {
        userId: toStringOrNull(raw.owner.userId) ?? "",
        name: toStringOrNull(raw.owner.name) ?? "Unknown",
        email: toStringOrNull(raw.owner.email) ?? "",
        image: toStringOrNull(raw.owner.image),
      }
    : { userId: "", name: "Unknown", email: "", image: null };
  return {
    shareId: toStringOrNull(raw.shareId) ?? "",
    token: toStringOrNull(raw.token) ?? "",
    workspaceId: toStringOrNull(raw.workspaceId) ?? "",
    serverId: toStringOrNull(raw.serverId) ?? "",
    projectId: toStringOrNull(raw.projectId) ?? "",
    projectName: toStringOrNull(raw.projectName) ?? "",
    workspaceName: toStringOrNull(raw.workspaceName) ?? "",
    orgId: toStringOrNull(raw.orgId) ?? "",
    accessLevel,
    pairingUrl: toStringOrNull(raw.pairingUrl),
    owner,
    expiresAt: toStringOrNull(raw.expiresAt),
    createdAt: toStringOrNull(raw.createdAt) ?? "",
    shareUrl: toStringOrNull(raw.shareUrl) ?? "",
  };
}

// ---------------------------------------------------------------------------
// Workspace share commands
// ---------------------------------------------------------------------------

export interface DesktopCreateWorkspaceShareParams {
  workspaceId: string;
  serverId: string;
  projectId: string;
  projectName: string;
  workspaceName: string;
  orgId: string;
  accessLevel: WorkspaceShareAccessLevel;
  pairingUrl?: string;
  allowedUserIds: string[];
  expiresInMinutes?: number;
}

export async function desktopAuthCreateWorkspaceShare(
  params: DesktopCreateWorkspaceShareParams,
): Promise<WorkspaceShareCreateResult> {
  const raw = await invokeDesktopCommand<unknown>(
    "desktop_auth_create_workspace_share",
    params as unknown as Record<string, unknown>,
  );
  if (!isRecord(raw)) {
    throw new Error("Unexpected response from workspace share creation.");
  }
  const accessLevelRaw = toStringOrNull(raw.accessLevel) ?? params.accessLevel;
  const accessLevel: WorkspaceShareAccessLevel =
    accessLevelRaw === "full_access" ? "full_access" : "read_only";
  return {
    shareId: toStringOrNull(raw.shareId) ?? "",
    token: toStringOrNull(raw.token) ?? "",
    shareUrl: toStringOrNull(raw.shareUrl) ?? "",
    accessLevel,
    expiresAt: toStringOrNull(raw.expiresAt),
  };
}

export interface DesktopUpdateWorkspaceShareParams {
  token: string;
  accessLevel?: WorkspaceShareAccessLevel;
  allowedUserIds?: string[];
  expiresInMinutes?: number | null;
}

export async function desktopAuthUpdateWorkspaceShare(
  params: DesktopUpdateWorkspaceShareParams,
): Promise<void> {
  await invokeDesktopCommand(
    "desktop_auth_update_workspace_share",
    params as unknown as Record<string, unknown>,
  );
}

export async function desktopAuthRevokeWorkspaceShare(token: string): Promise<void> {
  await invokeDesktopCommand("desktop_auth_revoke_workspace_share", { token });
}

export async function desktopAuthListWorkspaceShares(
  orgId: string,
): Promise<WorkspaceShareRecord[]> {
  const raw = await invokeDesktopCommand<unknown>("desktop_auth_list_workspace_shares", { orgId });
  if (!isRecord(raw) || !Array.isArray(raw.shares)) return [];
  return raw.shares
    .map(parseWorkspaceShareRecord)
    .filter((s): s is WorkspaceShareRecord => s !== null);
}

export async function desktopAuthListSharedWithMe(orgId: string): Promise<SharedWorkspaceRecord[]> {
  const raw = await invokeDesktopCommand<unknown>("desktop_auth_list_shared_with_me", { orgId });
  if (!isRecord(raw) || !Array.isArray(raw.shares)) return [];
  return raw.shares
    .map(parseSharedWorkspaceRecord)
    .filter((s): s is SharedWorkspaceRecord => s !== null);
}
