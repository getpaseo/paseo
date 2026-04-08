import {
  buildHostAgentDetailRoute,
  buildHostRootRoute,
  buildHostWorkspaceRoute,
} from "@/utils/host-routes";

type NotificationData = Record<string, unknown> | null | undefined;

function readNonEmptyString(data: NotificationData, key: string): string | null {
  const value = data?.[key];
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function resolveNotificationTarget(data: NotificationData): {
  serverId: string | null;
  agentId: string | null;
  workspaceId: string | null;
} {
  return {
    serverId: readNonEmptyString(data, "serverId"),
    agentId: readNonEmptyString(data, "agentId"),
    workspaceId: readNonEmptyString(data, "workspaceId") ?? readNonEmptyString(data, "cwd"),
  };
}

export function buildNotificationRoute(data: NotificationData) {
  const { serverId, agentId, workspaceId } = resolveNotificationTarget(data);
  if (serverId && agentId) {
    if (workspaceId) {
      const base = buildHostWorkspaceRoute(serverId, workspaceId);
      return `${base}?open=${encodeURIComponent(`agent:${agentId}`)}` as const;
    }
    return buildHostAgentDetailRoute(serverId, agentId);
  }
  if (serverId) {
    return buildHostRootRoute(serverId);
  }
  return "/" as const;
}
