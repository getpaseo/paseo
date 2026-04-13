import { buildHostSettingsRoute } from "@/utils/host-routes";

export const LEGACY_SETTINGS_FALLBACK_ROUTE = "/welcome";

export function resolveLegacySettingsTargetRoute(serverId: string | null | undefined): string {
  const normalizedServerId = typeof serverId === "string" ? serverId.trim() : "";
  if (!normalizedServerId) {
    return LEGACY_SETTINGS_FALLBACK_ROUTE;
  }
  return buildHostSettingsRoute(normalizedServerId);
}

