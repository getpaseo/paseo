import { router, usePathname } from "expo-router";
import { useCallback } from "react";
import { SidebarHeaderRow } from "@/components/sidebar/sidebar-header-row";
import { rememberPluginContributionHost } from "../contribution-host";
import { resolvePluginIcon } from "../icons";
import { buildPluginSurfaceRoute, hostIdFromPathname } from "../routes";
import { selectPluginSidebarTarget, type PluginSidebarGroup } from "../sidebar-groups";

// COMPAT(pluginSidebarAliases): added in v0.11.0, remove after 2027-03-29
/**
 * An `addSidebarItem({ id, title, icon, surface })` row. It opens `/sidebar/<id>`, so the screen's
 * header and host switcher belong to this item.
 */
export function LegacyPluginSidebarRow({
  group,
  onBeforeNavigate,
}: {
  group: Extract<PluginSidebarGroup, { kind: "legacy" }>;
  onBeforeNavigate?: () => void;
}) {
  const pathname = usePathname();
  const identity = { kind: "sidebar", id: group.contributionId } as const;
  const target = selectPluginSidebarTarget(group, hostIdFromPathname(pathname));
  const route = buildPluginSurfaceRoute(target.plugin.serverId, group.pluginId, identity);
  const isActive = group.targets.some(
    (candidate) =>
      pathname === buildPluginSurfaceRoute(candidate.plugin.serverId, group.pluginId, identity),
  );
  const navigate = useCallback(() => {
    rememberPluginContributionHost(group.key, target.plugin.serverId);
    onBeforeNavigate?.();
    router.push(route);
  }, [group.key, onBeforeNavigate, route, target.plugin.serverId]);
  return (
    <SidebarHeaderRow
      icon={resolvePluginIcon(group.icon)}
      label={group.title}
      onPress={navigate}
      isActive={isActive}
      testID={`plugin-sidebar-${group.pluginId}-${group.contributionId}`}
      variant="compact"
    />
  );
}
