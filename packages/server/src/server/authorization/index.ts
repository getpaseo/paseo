import type { SessionInboundMessage, SessionOutboundMessage } from "../messages.js";
import {
  requiredPermissionForInbound,
  requiredPermissionForOutbound,
} from "./operation-permissions.js";

export const DAEMON_PERMISSIONS = [
  "daemon.read",
  "daemon.manage",
  "tunnel.manage",
  "access.manage",
  "workspace.read",
  "workspace.write",
  "workspace.manage",
  "automation.manage",
  "hub.execute",
] as const;

export type DaemonPermission = (typeof DAEMON_PERMISSIONS)[number];

export const OWNER_PERMISSIONS: readonly DaemonPermission[] = DAEMON_PERMISSIONS;

export class SessionAuthorization {
  private permissions: ReadonlySet<DaemonPermission>;

  constructor(permissions: readonly DaemonPermission[]) {
    this.permissions = new Set(permissions);
  }

  allowsInbound(message: SessionInboundMessage): boolean {
    return this.allows(requiredPermissionForInbound(message.type));
  }

  allowsOutbound(message: SessionOutboundMessage): boolean {
    return this.allows(requiredPermissionForOutbound(message.type));
  }

  replacePermissions(permissions: readonly DaemonPermission[]): void {
    this.permissions = new Set(permissions);
  }

  private allows(permission: DaemonPermission | null): boolean {
    return permission === null || this.permissions.has(permission);
  }
}

const LEGACY_HUB_EXECUTION_SCOPE = "hub.execution.*";

export function permissionsForLegacyHubScopes(
  scopes: readonly string[],
): readonly DaemonPermission[] {
  // COMPAT(semanticHubPermissions): added in v0.7, remove after Hub enrollment uses permissions.
  return scopes.includes(LEGACY_HUB_EXECUTION_SCOPE) ? ["hub.execute"] : [];
}
