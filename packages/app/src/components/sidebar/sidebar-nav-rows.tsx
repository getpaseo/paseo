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
import { MenuItem, MenuTrigger } from "@/components/ui/menu";
import { SidebarPopoverRoot, SidebarPopoverSurface } from "@/components/sidebar/sidebar-popover";
import { DensityIcon } from "@/components/ui/density-icon";
import { Shortcut } from "@/components/ui/shortcut";
import { SidebarHeaderRow, type SidebarRowIcon } from "@/components/sidebar/sidebar-header-row";
import type { ShortcutKey } from "@/utils/format-shortcut";
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
  /** Inside the More surface this row is a menu item, so arrow keys can move between entries. */
  menu?: boolean;
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
  const { t } = useTranslation();
  const { items } = useSidebarNavItems("header");
  const visibleItems = useMemo(() => items.filter((item) => item.visible), [items]);
  const groupRef = useRef<View | null>(null);
  const [overflowOpen, setOverflowOpen] = useState(false);
  const rowLimit =
    maxRows === undefined || visibleItems.length <= maxRows
      ? visibleItems.length
      : Math.max(0, maxRows - 1);
  const overflowItems = visibleItems.slice(rowLimit);
  const closeOverflowAndNavigate = useCallback(() => {
    setOverflowOpen(false);
    onBeforeNavigate?.();
  }, [onBeforeNavigate]);

  if (visibleItems.length === 0 && !firstRowTrailing) return null;

  const renderRow = (item: (typeof visibleItems)[number], menu = false) => {
    const beforeNavigate = menu ? closeOverflowAndNavigate : onBeforeNavigate;
    if (item.kind === "plugin") {
      return (
        <PluginSidebarItem
          key={item.key}
          group={item.group}
          section="header"
          fallbackAnchorRef={groupRef}
          menu={menu}
          onBeforeNavigate={beforeNavigate}
        />
      );
    }
    const Row = BUILTIN_ROWS[item.id];
    return <Row key={item.key} menu={menu} onBeforeNavigate={beforeNavigate} />;
  };
  const rows = visibleItems.slice(0, rowLimit).map((item) => renderRow(item));
  if (overflowItems.length) {
    rows.push(
      <SidebarPopoverRoot key="overflow" open={overflowOpen} onOpenChange={setOverflowOpen}>
        <MenuTrigger
          accessibilityRole="button"
          accessibilityLabel={t("sidebar.nav.moreItems")}
          testID="sidebar-nav-overflow"
          style={styles.overflowTrigger}
        >
          <DensityIcon icon={Ellipsis} size="sm" color="foregroundMuted" />
          <Text style={styles.overflowLabel}>{t("sidebar.nav.more")}</Text>
        </MenuTrigger>
        <SidebarPopoverSurface
          section="header"
          title={t("sidebar.nav.more")}
          testID="sidebar-nav-overflow-menu"
        >
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

function SidebarNavMenuItem({
  icon,
  label,
  onPress,
  isActive,
  testID,
  shortcutKeys,
}: {
  icon: SidebarRowIcon;
  label: string;
  onPress: () => void;
  isActive: boolean;
  testID: string;
  shortcutKeys: ShortcutKey[][] | null;
}) {
  const leading = useMemo(
    () => <DensityIcon icon={icon} size="sm" color="foregroundMuted" />,
    [icon],
  );
  const trailing = useMemo(() => {
    if (!shortcutKeys) return null;
    return <Shortcut chord={shortcutKeys} />;
  }, [shortcutKeys]);
  return (
    <MenuItem
      leading={leading}
      trailing={trailing}
      onSelect={onPress}
      active={isActive}
      testID={testID}
    >
      {label}
    </MenuItem>
  );
}

function SidebarNavEntry({
  menu = false,
  icon,
  label,
  onPress,
  isActive = false,
  testID,
  shortcutKeys = null,
}: {
  menu?: boolean;
  icon: SidebarRowIcon;
  label: string;
  onPress: () => void;
  isActive?: boolean;
  testID: string;
  shortcutKeys?: ShortcutKey[][] | null;
}) {
  if (menu) {
    return (
      <SidebarNavMenuItem
        icon={icon}
        label={label}
        onPress={onPress}
        isActive={isActive}
        testID={testID}
        shortcutKeys={shortcutKeys}
      />
    );
  }
  return (
    <SidebarHeaderRow
      icon={icon}
      label={label}
      onPress={onPress}
      isActive={isActive}
      testID={testID}
      variant="compact"
      shortcutKeys={shortcutKeys}
    />
  );
}

const SidebarNewWorkspaceRow = memo(function SidebarNewWorkspaceRow({
  onBeforeNavigate,
  menu = false,
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
    <SidebarNavEntry
      menu={menu}
      icon={Plus}
      label={t(builtinSidebarNavLabelKey("new-workspace"))}
      onPress={handlePress}
      testID="sidebar-global-new-workspace"
      shortcutKeys={shortcutKeys}
    />
  );
});

function SidebarHistoryRow({ onBeforeNavigate, menu = false }: SidebarNavRowProps) {
  const { t } = useTranslation();
  const pathname = usePathname();
  const handlePress = useCallback(() => {
    onBeforeNavigate?.();
    router.push(buildSessionsRoute());
  }, [onBeforeNavigate]);

  return (
    <SidebarNavEntry
      menu={menu}
      icon={History}
      label={t(builtinSidebarNavLabelKey("history"))}
      onPress={handlePress}
      isActive={pathname.includes("/sessions")}
      testID="sidebar-sessions"
    />
  );
}

function SidebarSearchRow({ onBeforeNavigate, menu = false }: SidebarNavRowProps) {
  const { t } = useTranslation();
  const shortcutKeys = useShortcutKeys(builtinSidebarNavShortcutAction("search"));
  const setCommandCenterOpen = useKeyboardShortcutsStore((state) => state.setCommandCenterOpen);
  const handlePress = useCallback(() => {
    onBeforeNavigate?.();
    setCommandCenterOpen(true);
  }, [onBeforeNavigate, setCommandCenterOpen]);

  return (
    <SidebarNavEntry
      menu={menu}
      icon={Search}
      label={t(builtinSidebarNavLabelKey("search"))}
      onPress={handlePress}
      testID="sidebar-search"
      shortcutKeys={shortcutKeys}
    />
  );
}

function SidebarSchedulesRow({ onBeforeNavigate, menu = false }: SidebarNavRowProps) {
  const { t } = useTranslation();
  const pathname = usePathname();
  const handlePress = useCallback(() => {
    onBeforeNavigate?.();
    router.push(buildSchedulesRoute());
  }, [onBeforeNavigate]);

  return (
    <SidebarNavEntry
      menu={menu}
      icon={CalendarClock}
      label={t(builtinSidebarNavLabelKey("schedules"))}
      onPress={handlePress}
      isActive={pathname.includes("/schedules")}
      testID="sidebar-schedules"
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
