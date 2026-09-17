export function buildPluginSettingsRoute(serverId: string, pluginId: string, screenId: string) {
  return {
    pathname: "/settings/hosts/[serverId]/plugins/[pluginId]/[screenId]" as const,
    params: { serverId, pluginId, screenId },
  };
}
