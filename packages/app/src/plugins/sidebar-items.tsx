import { router, usePathname } from "expo-router";
import { useCallback, useSyncExternalStore } from "react";
import { SidebarHeaderRow } from "@/components/sidebar/sidebar-header-row";
import { resolvePluginIcon } from "./icons";
import { buildPluginSurfaceRoute, hostIdFromPathname } from "./routes";
import {
  getPreferredPluginContributionHost,
  rememberPluginContributionHost,
} from "./contribution-host";
import { type PluginSidebarGroup, type PluginSidebarTarget } from "./sidebar-groups";

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

const NO_BADGE_UNSUBSCRIBE = () => {};

/**
 * Sums the badge counts of every target in the group, because one sidebar row
 * can stand for the same contribution on several hosts. Null when no target
 * contributes a badge.
 */
export function readPluginSidebarBadge(group: PluginSidebarGroup): number | null {
  let total: number | null = null;
  for (const target of group.targets) {
    const count = target.item.badge?.getSnapshot() ?? null;
    if (count === null) continue;
    total = (total ?? 0) + count;
  }
  return total;
}

function usePluginSidebarBadge(group: PluginSidebarGroup): number | null {
  const subscribe = useCallback(
    (listener: () => void) => {
      const unsubscribes = group.targets.flatMap((target) =>
        target.item.badge ? [target.item.badge.subscribe(listener)] : [],
      );
      if (unsubscribes.length === 0) return NO_BADGE_UNSUBSCRIBE;
      return () => {
        for (const unsubscribe of unsubscribes) unsubscribe();
      };
    },
    [group],
  );
  const getSnapshot = useCallback(() => readPluginSidebarBadge(group), [group]);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

export function PluginSidebarItemRow({
  group,
  onBeforeNavigate,
}: {
  group: PluginSidebarGroup;
  onBeforeNavigate?: () => void;
}) {
  const pathname = usePathname();
  const badgeCount = usePluginSidebarBadge(group);
  const target = selectTarget(group, hostIdFromPathname(pathname));
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
      badgeCount={badgeCount}
    />
  );
}
