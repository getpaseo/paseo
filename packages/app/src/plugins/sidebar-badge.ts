import { PluginSidebarBadgeSchema } from "@getpaseo/plugin";
import { readPluginSidebarBadge, resolvePluginSidebarBadgeInterval } from "@getpaseo/plugin/host";
import { useFetchQuery } from "@/data/query";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import type { PluginSidebarTarget } from "./sidebar-groups";
import type { InstalledPlugin } from "./types";

const NO_BADGE = 0;

export function pluginSidebarBadgeQueryKey(serverId: string, pluginId: string, itemId: string) {
  return ["plugin-sidebar-badge", serverId, pluginId, itemId] as const;
}

export function setPluginSidebarBadgeCount(
  plugin: Pick<InstalledPlugin, "id" | "queryClient" | "serverId" | "sidebarItems">,
  itemId: string,
  count: number,
): void {
  const item = plugin.sidebarItems.find((candidate) => candidate.id === itemId);
  if (!item?.badge) {
    throw new Error(`Plugin sidebar item ${itemId} does not have a badge`);
  }
  const badge = PluginSidebarBadgeSchema.parse({ count });
  plugin.queryClient.setQueryData(
    pluginSidebarBadgeQueryKey(plugin.serverId, plugin.id, itemId),
    badge,
  );
}

/**
 * Polls the badge RPC of whichever installation the sidebar row currently
 * points at. The row is mounted app-wide, so this is the one plugin poll that
 * runs without a surface being open — keep it cheap and keep the floor on
 * `intervalMs` in the SDK, not here.
 */
export function usePluginSidebarBadgeCount(target: PluginSidebarTarget): number {
  const { plugin, item } = target;
  const client = useHostRuntimeClient(plugin.serverId);
  const intervalMs = resolvePluginSidebarBadgeInterval(item.badge?.intervalMs);
  const badge = useFetchQuery(
    {
      queryKey: pluginSidebarBadgeQueryKey(plugin.serverId, plugin.id, item.id),
      queryFn: async () => {
        if (!client) throw new Error("Plugin host is offline");
        const invoke = (method: string, input: unknown) =>
          client.invokePluginRpc(plugin.id, method, input);
        return (await readPluginSidebarBadge(item, invoke)) ?? { count: NO_BADGE };
      },
      enabled: Boolean(item.badge && client),
      dataShape: "value",
      staleTimeMs: intervalMs,
      refetchInterval: intervalMs,
      retry: false,
    },
    plugin.queryClient,
  );
  // A failing or offline badge poll shows no badge rather than a stale count.
  return badge.error ? NO_BADGE : (badge.data?.count ?? NO_BADGE);
}
