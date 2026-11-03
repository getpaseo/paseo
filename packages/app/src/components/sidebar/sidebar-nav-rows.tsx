import { router, usePathname } from "expo-router";
import { CalendarClock, Ellipsis, History, Plus, Search } from "lucide-react-native";
import {
  memo,
  useCallback,
  useMemo,
  useRef,
  useState,
  type ComponentType,
  type ReactNode,
} from "react";
import { useTranslation } from "react-i18next";
import { Text, View, type StyleProp, type ViewStyle } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { MenuTrigger } from "@/components/ui/menu";
import { SidebarPopoverRoot, SidebarPopoverSurface } from "@/components/sidebar/sidebar-popover";
import { DensityIcon } from "@/components/ui/density-icon";
import { SidebarHeaderRow } from "@/components/sidebar/sidebar-header-row";
import { useShortcutKeys } from "@/hooks/use-shortcut-keys";
import { PluginSidebarItem } from "@/plugins/sidebar-items";
import { canCreateWorktreeForProjectKind } from "@/projects/host-projects";
import { useHostFeature } from "@/runtime/host-features";
import {
  builtinSidebarNavLabelKey,
  builtinSidebarNavShortcutAction,
  type BuiltinSidebarNavId,
} from "@/sidebar-nav/model";
import { useSidebarNavItems } from "@/sidebar-nav/use-sidebar-nav-items";
import { useKeyboardShortcutsStore } from "@/stores/keyboard-shortcuts-store";
import { useActiveWorkspaceSelection } from "@/stores/navigation-active-workspace-store";
import { useWorkspace } from "@/stores/session-store-hooks";
import {
  buildNewWorkspaceRoute,
  buildSchedulesRoute,
  buildSessionsRoute,
} from "@/utils/host-routes";

interface SidebarNavRowProps {
  onBeforeNavigate?: () => void;
}

interface SidebarNavRowsProps extends SidebarNavRowProps {
  /** Style for the group wrapper, which the sidebar owns. */
  style?: StyleProp<ViewStyle>;
  /** Sits to the right of the first row, which shrinks to make room. */
  firstRowTrailing?: ReactNode;
  maxRows?: number;
}

/**
 * Top-level sidebar navigation, ordered and filtered by the user's
 * `sidebarNavItems` preference. Renders nothing — not even the bordered group
 * wrapper — when every item is hidden and there is no `firstRowTrailing`.
 */
export function SidebarNavRows({
  style,
  onBeforeNavigate,
  firstRowTrailing,
  maxRows,
}: SidebarNavRowsProps) {
  const { items } = useSidebarNavItems("header");
  const visibleItems = useMemo(() => items.filter((item) => item.visible), [items]);
  const groupRef = useRef<View | null>(null);
  const [overflowOpen, setOverflowOpen] = useState(false);
  const rowLimit =
    maxRows === undefined || visibleItems.length <= maxRows
      ? visibleItems.length
      : Math.max(0, maxRows - 1);
  const overflowItems = visibleItems.slice(rowLimit);
  const closeOverflowAndNavigate = () => {
    setOverflowOpen(false);
    onBeforeNavigate?.();
  };

  if (visibleItems.length === 0 && !firstRowTrailing) return null;

  const renderRow = (item: (typeof visibleItems)[number], overflow = false) => {
    if (item.kind === "plugin") {
      return (
        <PluginSidebarItem
          key={item.key}
          group={item.group}
          section="header"
          fallbackAnchorRef={groupRef}
          onBeforeNavigate={overflow ? closeOverflowAndNavigate : onBeforeNavigate}
        />
      );
    }
    const Row = BUILTIN_ROWS[item.id];
    return (
      <Row
        key={item.key}
        onBeforeNavigate={overflow ? closeOverflowAndNavigate : onBeforeNavigate}
      />
    );
  };
  const rows = visibleItems.slice(0, rowLimit).map((item) => renderRow(item));
  if (overflowItems.length) {
    rows.push(
      <SidebarPopoverRoot key="overflow" open={overflowOpen} onOpenChange={setOverflowOpen}>
        <MenuTrigger
          accessibilityRole="button"
          accessibilityLabel="More menu items"
          testID="sidebar-nav-overflow"
          style={styles.overflowTrigger}
        >
          <DensityIcon icon={Ellipsis} size="sm" color="foregroundMuted" />
          <Text style={styles.overflowLabel}>More</Text>
        </MenuTrigger>
        <SidebarPopoverSurface section="header" title="More" testID="sidebar-nav-overflow-menu">
          {overflowItems.map((item) => renderRow(item, true))}
        </SidebarPopoverSurface>
      </SidebarPopoverRoot>,
    );
  }
  const [firstRow, ...restRows] = rows;

  return (
    <View ref={groupRef} collapsable={false} style={style}>
      {firstRowTrailing ? (
        <View style={styles.firstRow}>
          <View style={styles.firstRowItem}>{firstRow}</View>
          {firstRowTrailing}
        </View>
      ) : (
        firstRow
      )}
      {restRows}
    </View>
  );
}

const SidebarNewWorkspaceRow = memo(function SidebarNewWorkspaceRow({
  onBeforeNavigate,
}: SidebarNavRowProps) {
  const { t } = useTranslation();
  const shortcutKeys = useShortcutKeys(builtinSidebarNavShortcutAction("new-workspace"));
  const activeWorkspaceSelection = useActiveWorkspaceSelection();
  const activeWorkspaceServerId = activeWorkspaceSelection?.serverId ?? null;
  const activeWorkspaceId = activeWorkspaceSelection?.workspaceId ?? null;
  const activeWorkspace = useWorkspace(activeWorkspaceServerId, activeWorkspaceId);
  const supportsWorkspaceMultiplicity = useHostFeature(
    activeWorkspaceServerId,
    "workspaceMultiplicity",
  );
  const canUseActiveWorkspaceContext = Boolean(
    activeWorkspace &&
    (supportsWorkspaceMultiplicity || canCreateWorktreeForProjectKind(activeWorkspace.projectKind)),
  );

  const handlePress = useCallback(() => {
    onBeforeNavigate?.();
    router.push(
      activeWorkspaceServerId
        ? buildNewWorkspaceRoute(
            activeWorkspace && canUseActiveWorkspaceContext
              ? {
                  serverId: activeWorkspaceServerId,
                  sourceDirectory: activeWorkspace.projectRootPath,
                  projectId: activeWorkspace.projectId,
                }
              : { serverId: activeWorkspaceServerId },
          )
        : buildNewWorkspaceRoute(),
    );
  }, [activeWorkspace, activeWorkspaceServerId, canUseActiveWorkspaceContext, onBeforeNavigate]);

  return (
    <SidebarHeaderRow
      icon={Plus}
      label={t(builtinSidebarNavLabelKey("new-workspace"))}
      onPress={handlePress}
      testID="sidebar-global-new-workspace"
      variant="compact"
      shortcutKeys={shortcutKeys}
    />
  );
});

function SidebarHistoryRow({ onBeforeNavigate }: SidebarNavRowProps) {
  const { t } = useTranslation();
  const pathname = usePathname();
  const handlePress = useCallback(() => {
    onBeforeNavigate?.();
    router.push(buildSessionsRoute());
  }, [onBeforeNavigate]);

  return (
    <SidebarHeaderRow
      icon={History}
      label={t(builtinSidebarNavLabelKey("history"))}
      onPress={handlePress}
      isActive={pathname.includes("/sessions")}
      testID="sidebar-sessions"
      variant="compact"
    />
  );
}

function SidebarSearchRow({ onBeforeNavigate }: SidebarNavRowProps) {
  const { t } = useTranslation();
  const shortcutKeys = useShortcutKeys(builtinSidebarNavShortcutAction("search"));
  const setCommandCenterOpen = useKeyboardShortcutsStore((state) => state.setCommandCenterOpen);
  const handlePress = useCallback(() => {
    onBeforeNavigate?.();
    setCommandCenterOpen(true);
  }, [onBeforeNavigate, setCommandCenterOpen]);

  return (
    <SidebarHeaderRow
      icon={Search}
      label={t(builtinSidebarNavLabelKey("search"))}
      onPress={handlePress}
      testID="sidebar-search"
      variant="compact"
      shortcutKeys={shortcutKeys}
    />
  );
}

function SidebarSchedulesRow({ onBeforeNavigate }: SidebarNavRowProps) {
  const { t } = useTranslation();
  const pathname = usePathname();
  const handlePress = useCallback(() => {
    onBeforeNavigate?.();
    router.push(buildSchedulesRoute());
  }, [onBeforeNavigate]);

  return (
    <SidebarHeaderRow
      icon={CalendarClock}
      label={t(builtinSidebarNavLabelKey("schedules"))}
      onPress={handlePress}
      isActive={pathname.includes("/schedules")}
      testID="sidebar-schedules"
      variant="compact"
    />
  );
}

const BUILTIN_ROWS: Record<BuiltinSidebarNavId, ComponentType<SidebarNavRowProps>> = {
  "new-workspace": SidebarNewWorkspaceRow,
  history: SidebarHistoryRow,
  search: SidebarSearchRow,
  schedules: SidebarSchedulesRow,
};

const styles = StyleSheet.create((theme) => ({
  overflowTrigger: {
    minHeight: 36,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[4],
  },
  overflowLabel: { fontSize: theme.fontSize.base, color: theme.colors.foregroundMuted },
  firstRow: {
    flexDirection: "row",
    alignItems: "center",
  },
  firstRowItem: {
    flex: 1,
    minWidth: 0,
  },
}));
