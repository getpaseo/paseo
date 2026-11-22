import type { SessionInboundMessage, SessionOutboundMessage } from "../messages.js";
import { DAEMON_PERMISSIONS, type DaemonPermission } from "@getpaseo/protocol/messages";
import {
  type PermissionRequirement,
  requiredPermissionForInbound,
  requiredPermissionForOutbound,
} from "./operation-permissions.js";

export { DAEMON_PERMISSIONS, type DaemonPermission };

const daemonPermissionSet: ReadonlySet<string> = new Set(DAEMON_PERMISSIONS);

export function isDaemonPermission(value: string): value is DaemonPermission {
  return daemonPermissionSet.has(value);
}

export function parseDaemonPermissions(values: readonly string[]): DaemonPermission[] {
  const permissions = [...new Set(values)];
  if (!permissions.every(isDaemonPermission)) throw new Error("Invalid daemon permission");
  return permissions;
}

export const OWNER_PERMISSIONS: readonly DaemonPermission[] = DAEMON_PERMISSIONS;

type HostInstructionsManagement = Extract<
  SessionInboundMessage,
  { type: "host.instructions.manage.request" }
>;
type InboundAuthorizationMessage =
  | HostInstructionsManagement
  | { type: Exclude<SessionInboundMessage["type"], HostInstructionsManagement["type"]> };

export class SessionAuthorization {
  private permissions: ReadonlySet<DaemonPermission>;

  constructor(permissions: readonly DaemonPermission[]) {
    this.permissions = new Set(permissions);
  }

  allowsInbound(message: InboundAuthorizationMessage): boolean {
    if (!this.allows(requiredPermissionForInbound(message.type))) return false;
    if (message.type !== "host.instructions.manage.request") return true;

    const command = message.command;
    const promptAuthority = requiredPermissionForInbound("send_agent_message_request");
    switch (command.action) {
      case "set_policy":
        // Host policies also expose a directory of the conversations they cover.
        return (
          this.allows(promptAuthority) &&
          this.allows(requiredPermissionForInbound("fetch_agents_request"))
        );
      case "grant":
        return this.allows(promptAuthority);
      case "decide":
        return !command.approve || this.allows(promptAuthority);
      default:
        return true;
    }
  }

  allowsOutbound(message: SessionOutboundMessage): boolean {
    return this.allows(requiredPermissionForOutbound(message));
  }

  replacePermissions(permissions: readonly DaemonPermission[]): void {
    this.permissions = new Set(permissions);
  }

  listPermissions(): DaemonPermission[] {
    return [...this.permissions];
  }

  allowsPermission(permission: DaemonPermission): boolean {
    return this.permissions.has(permission);
  }

  private allows(requirement: PermissionRequirement): boolean {
    if (requirement === null) return true;
    if (typeof requirement === "string") return this.permissions.has(requirement);
    return requirement.some((permission) => this.permissions.has(permission));
  }
}

const LEGACY_HUB_EXECUTION_SCOPE = "hub.execution.*";

export function permissionsForLegacyHubScopes(
  scopes: readonly string[],
): readonly DaemonPermission[] {
  // COMPAT(semanticHubPermissions): added in v0.7, remove after Hub enrollment uses permissions.
  return scopes.includes(LEGACY_HUB_EXECUTION_SCOPE) ? ["hub.execute"] : [];
}
