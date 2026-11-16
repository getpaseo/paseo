import { router, usePathname } from "expo-router";
import { useCallback, useMemo } from "react";
import { SidebarHeaderRow } from "@/components/sidebar/sidebar-header-row";
import { DensityIcon } from "@/components/ui/density-icon";
import { MenuItem } from "@/components/ui/menu";
import { rememberPluginContributionHost } from "../contribution-host";
import { pluginIconComponent } from "../icons";
import { buildPluginSurfaceRoute, hostIdFromPathname } from "../routes";
import { selectPluginSidebarTarget, type PluginSidebarGroup } from "../sidebar-groups";

// COMPAT(pluginSidebarAliases): added in v0.11.0, remove after 2027-03-29
/**
 * An `addSidebarItem({ id, title, icon, surface })` row. It opens `/sidebar/<id>`, so the screen's
 * header and host switcher belong to this item.
 */
export function LegacyPluginSidebarRow({
  group,
  menu = false,
  onBeforeNavigate,
}: {
  group: Extract<PluginSidebarGroup, { kind: "legacy" }>;
  menu?: boolean;
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
  const testID = `plugin-sidebar-${group.pluginId}-${group.contributionId}`;
  const icon = pluginIconComponent(group.icon);
  const leading = useMemo(
    () => <DensityIcon icon={icon} size="sm" color="foregroundMuted" />,
    [icon],
  );
  if (menu) {
    return (
      <MenuItem leading={leading} onSelect={navigate} active={isActive} testID={testID}>
        {group.title}
      </MenuItem>
    );
  }
  return (
    <SidebarHeaderRow
      icon={icon}
      label={group.title}
      onPress={navigate}
      isActive={isActive}
      testID={testID}
      variant="compact"
    />
  );
}
