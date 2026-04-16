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
   * Validate a share token and check if the user is allowed to join.
   */
  async validateShareToken(token: string, sessionToken: string): Promise<ShareValidation> {
    try {
      const response = await fetch(`${this.baseUrl}/api/sessions/share/${encodeURIComponent(token)}`, {
        headers: {
          Authorization: `Bearer ${sessionToken}`,
        },
      });

      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        return {
          allowed: false,
          reason: (body as { error?: string }).error ?? `HTTP ${response.status}`,
        };
      }

      const data = (await response.json()) as {
        shareId: string;
        daemonSessionId: string;
        serverId: string;
        accessLevel: string;
        owner: { userId: string; username: string; avatarUrl: string };
        currentUser: { userId: string; username: string; avatarUrl: string; isOwner: boolean };
      };

      return {
        allowed: true,
        user: data.currentUser,
        daemonSessionId: data.daemonSessionId,
        serverId: data.serverId,
        accessLevel: data.accessLevel,
      };
    } catch (error) {
      return {
        allowed: false,
        reason: error instanceof Error ? error.message : "Failed to validate token",
      };
    }
  }

  /**
   * Record that a user joined a shared session.
   */
  async recordJoin(shareToken: string, userId: string): Promise<void> {
    try {
      await fetch(`${this.baseUrl}/api/sessions/share/${encodeURIComponent(shareToken)}/participants`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId, action: "join" }),
      });
    } catch {
      // Non-critical — don't fail the join
    }
  }

  /**
   * Record that a user left a shared session.
   */
  async recordLeave(shareToken: string, userId: string): Promise<void> {
    try {
      await fetch(`${this.baseUrl}/api/sessions/share/${encodeURIComponent(shareToken)}/participants`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId, action: "leave" }),
      });
    } catch {
      // Non-critical
    }
  }
}
