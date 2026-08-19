import { router, usePathname } from "expo-router";
import { useCallback, useMemo } from "react";
import { SidebarHeaderRow } from "@/components/sidebar/sidebar-header-row";
import { resolvePluginIcon } from "./icons";
import { useInstalledPlugins } from "./registry";
import { buildPluginSurfaceRoute, hostIdFromPathname } from "./routes";
import {
  groupPluginSidebarContributions,
  getPreferredPluginContributionHost,
  rememberPluginContributionHost,
  type PluginSidebarGroup,
  type PluginSidebarTarget,
} from "./sidebar-groups";

function selectTarget(
  group: PluginSidebarGroup,
  currentHostId: string | null,
): PluginSidebarTarget {
  const current = group.targets.find((target) => target.plugin.serverId === currentHostId);
  if (current) return current;
  const rememberedHostId = getPreferredPluginContributionHost(group.key);
  const remembered = group.targets.find((target) => target.plugin.serverId === rememberedHostId);
  return remembered ?? group.targets[0];
}

export function PluginSidebarItems({ onBeforeNavigate }: { onBeforeNavigate?: () => void }) {
  const plugins = useInstalledPlugins();
  const pathname = usePathname();
  const groups = useMemo(() => groupPluginSidebarContributions(plugins), [plugins]);
  const currentHostId = hostIdFromPathname(pathname);

  return groups.map((group) => (
    <PluginSidebarItemRow
      key={group.key}
      group={group}
      currentHostId={currentHostId}
      pathname={pathname}
      onBeforeNavigate={onBeforeNavigate}
    />
  ));
}

function PluginSidebarItemRow({
  group,
  currentHostId,
  pathname,
  onBeforeNavigate,
}: {
  group: PluginSidebarGroup;
  currentHostId: string | null;
  pathname: string;
  onBeforeNavigate?: () => void;
}) {
  const target = selectTarget(group, currentHostId);
  const route = buildPluginSurfaceRoute(target.plugin.serverId, group.pluginId, {
    kind: "sidebar",
    id: group.contributionId,
  });
  const isActive = group.targets.some(
    (candidate) =>
      pathname ===
      buildPluginSurfaceRoute(candidate.plugin.serverId, group.pluginId, {
        kind: "sidebar",
        id: group.contributionId,
      }),
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
