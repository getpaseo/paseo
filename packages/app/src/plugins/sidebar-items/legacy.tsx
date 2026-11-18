import { usePathname } from "expo-router";
import { navigateToHostLeaf } from "@/navigation/workspace-route-navigation";
import { useCallback, useMemo } from "react";
import { SidebarHeaderRow } from "@/components/sidebar/sidebar-header-row";
import { rememberPluginContributionHost } from "../contribution-host";
import { pluginIconComponent } from "../icons";
import { buildPluginSurfaceLeaf, buildPluginSurfaceRoute, hostIdFromPathname } from "../routes";
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
  const isActive = group.targets.some(
    (candidate) =>
      pathname === buildPluginSurfaceRoute(candidate.plugin.serverId, group.pluginId, identity),
  );
  const leaf = useMemo(
    () =>
      buildPluginSurfaceLeaf(target.plugin.serverId, group.pluginId, {
        kind: "sidebar",
        id: group.contributionId,
      }),
    [group.contributionId, group.pluginId, target.plugin.serverId],
  );
  const navigate = useCallback(() => {
    rememberPluginContributionHost(group.key, target.plugin.serverId);
    onBeforeNavigate?.();
    navigateToHostLeaf(leaf);
  }, [group.key, leaf, onBeforeNavigate, target.plugin.serverId]);
  return (
    <SidebarHeaderRow
      icon={pluginIconComponent(group.icon)}
      label={group.title}
      onPress={navigate}
      isActive={isActive}
      testID={`plugin-sidebar-${group.pluginId}-${group.contributionId}`}
      variant="compact"
    />
  );
}
