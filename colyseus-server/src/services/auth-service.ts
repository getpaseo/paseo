import { config } from "../config.js";

export interface ValidatedUser {
  userId: string;
  username: string;
  avatarUrl: string;
  isOwner: boolean;
}

export interface ShareValidation {
  allowed: boolean;
  reason?: string;
  user?: ValidatedUser;
  daemonSessionId?: string;
  serverId?: string;
  accessLevel?: string;
}

export class AuthService {
  private baseUrl: string;

  constructor(baseUrl?: string) {
    this.baseUrl = baseUrl ?? config.authServerUrl;
  }

  /**
   * Validate a workspace share token and check if the user is allowed to join.
   *
   * Enforces (server-side in auth-server):
   * - Token exists, not revoked, not expired
   * - Caller is a member of the owning organization
   * - Caller is in allowedUserIds (or list is empty = open to all org members)
   */
  async validateShareToken(token: string, sessionToken: string): Promise<ShareValidation> {
    const url = `${this.baseUrl}/api/workspaces/share/${encodeURIComponent(token)}`;
    try {
      console.log(`[auth] validateShareToken GET ${url}`);
      const response = await fetch(url, {
        headers: { Authorization: `Bearer ${sessionToken}` },
      });

      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        const reason = (body as { error?: string }).error ?? `HTTP ${response.status}`;
        console.warn(`[auth] validateShareToken FAIL status=${response.status} reason="${reason}"`);
        return { allowed: false, reason };
      }

      const data = (await response.json()) as {
        shareId: string;
        workspaceId: string;
        serverId: string;
        accessLevel: string;
        owner: { userId: string; name: string; email: string; image: string | null };
        currentUser: {
          userId: string;
          name?: string;
          email?: string;
          image?: string | null;
          isOwner: boolean;
        };
      };

      const resolvedName =
        data.currentUser?.name ?? (data.currentUser?.isOwner ? data.owner?.name : null) ?? "Guest";
      const resolvedAvatar =
        data.currentUser?.image ?? (data.currentUser?.isOwner ? data.owner?.image : null) ?? "";

      console.log(
        `[auth] validateShareToken OK user=${data.currentUser?.userId} name=${resolvedName} isOwner=${data.currentUser?.isOwner} workspace=${data.workspaceId} accessLevel=${data.accessLevel}`,
      );
      return {
        allowed: true,
        user: {
          userId: data.currentUser.userId,
          username: resolvedName,
          avatarUrl: resolvedAvatar,
          isOwner: data.currentUser.isOwner,
        },
        // Workspace id doubles as the session identifier for room dedup + daemon routing
        daemonSessionId: data.workspaceId,
        serverId: data.serverId,
        accessLevel: data.accessLevel,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to validate token";
      console.error(`[auth] validateShareToken ERROR url=${url} reason="${message}"`);
      return { allowed: false, reason: message };
    }
  }

  /** Kept as a no-op for backward compatibility with the shared-session-room contract. */
  async recordJoin(_shareToken: string, _userId: string): Promise<void> {
    void _shareToken;
    void _userId;
  }

  /** Kept as a no-op for backward compatibility with the shared-session-room contract. */
  async recordLeave(_shareToken: string, _userId: string): Promise<void> {
    void _shareToken;
    void _userId;
  }
}
