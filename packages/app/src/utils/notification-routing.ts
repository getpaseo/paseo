import type { Href } from "expo-router";
import { buildPluginSurfaceRoute } from "@/plugins/routes";
import { buildHostRootRoute, buildHostWorkspaceOpenRoute } from "@/utils/host-routes";

type NotificationData = Record<string, unknown> | null | undefined;
type NotificationRoute = Extract<Href, string>;

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
  terminalId: string | null;
  pluginId: string | null;
  pluginSurfaceId: string | null;
} {
  return {
    serverId: readNonEmptyString(data, "serverId"),
    agentId: readNonEmptyString(data, "agentId"),
    workspaceId: readNonEmptyString(data, "workspaceId"),
    terminalId: readNonEmptyString(data, "terminalId"),
    pluginId: readNonEmptyString(data, "pluginId"),
    pluginSurfaceId: readNonEmptyString(data, "pluginSurfaceId"),
  };
}

export function buildNotificationRoute(data: NotificationData): NotificationRoute {
  const { serverId, agentId, workspaceId, terminalId, pluginId, pluginSurfaceId } =
    resolveNotificationTarget(data);
  if (serverId && workspaceId && agentId) {
    return buildHostWorkspaceOpenRoute(serverId, workspaceId, `agent:${agentId}`);
  }
  if (serverId && workspaceId && terminalId) {
    return buildHostWorkspaceOpenRoute(serverId, workspaceId, `terminal:${terminalId}`);
  }
  if (serverId && pluginId && pluginSurfaceId) {
    return buildPluginSurfaceRoute(serverId, pluginId, { kind: "surface", id: pluginSurfaceId });
  }
  if (serverId) {
    return buildHostRootRoute(serverId);
  }
  return "/" as const;
}
