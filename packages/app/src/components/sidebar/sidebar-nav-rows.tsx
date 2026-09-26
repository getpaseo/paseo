import { router, usePathname } from "expo-router";
import { CalendarClock, History, Plus, Search } from "lucide-react-native";
import { memo, useCallback, useMemo, useState, type ComponentType } from "react";
import { useTranslation } from "react-i18next";
import {
  ScrollView,
  useWindowDimensions,
  View,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { SidebarHeaderRow } from "@/components/sidebar/sidebar-header-row";
import { SidebarNavResizeHandle } from "@/components/sidebar/sidebar-nav-resize-handle";
import { SidebarSectionHeader } from "@/components/sidebar/sidebar-section-header";
import { useShortcutKeys } from "@/hooks/use-shortcut-keys";
import { PluginSidebarItemRow } from "@/plugins/sidebar-items";
import { canCreateWorktreeForProjectKind } from "@/projects/host-projects";
import { useHostFeature } from "@/runtime/host-features";
import {
  builtinSidebarNavLabelKey,
  builtinSidebarNavShortcutAction,
  type BuiltinSidebarNavId,
} from "@/sidebar-nav/model";
import { resolveSidebarNavGroupHeight } from "@/sidebar-nav/group-layout";
import { useSidebarNavItems } from "@/sidebar-nav/use-sidebar-nav-items";
import { useKeyboardShortcutsStore } from "@/stores/keyboard-shortcuts-store";
import { useActiveWorkspaceSelection } from "@/stores/navigation-active-workspace-store";
import { useWorkspace } from "@/stores/session-store-hooks";
import { usePanelStore } from "@/stores/panel-store";
import { useSidebarViewStore } from "@/stores/sidebar-view-store";
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
}

/**
 * Top-level sidebar navigation, ordered and filtered by the user's
 * `sidebarNavItems` preference. Renders nothing — not even the bordered group
 * wrapper — when every item is hidden.
 *
 * The group folds down to its header on demand and its rows scroll inside a cap,
 * so plugin contributions never push the workspace list off the sidebar.
 */
export function SidebarNavRows({ style, onBeforeNavigate }: SidebarNavRowsProps) {
  const { t } = useTranslation();
  const { items } = useSidebarNavItems();
  const visibleItems = useMemo(() => items.filter((item) => item.visible), [items]);
  const collapsed = useSidebarViewStore((state) => state.navCollapsed);
  const toggleCollapsed = useSidebarViewStore((state) => state.toggleNavCollapsed);
  const storedHeight = usePanelStore((state) => state.sidebarNavHeight);
  const setStoredHeight = usePanelStore((state) => state.setSidebarNavHeight);
  const { height: viewportHeight } = useWindowDimensions();
  // The drag previews at 60Hz; only the released height reaches the store.
  const [draggedHeight, setDraggedHeight] = useState<number | null>(null);
  // Until the owner drags it, the group is still only as tall as its rows, capped at
  // its share of the window. A dragged height is a height, not a ceiling.
  const requestedHeight = draggedHeight ?? storedHeight;
  const height = resolveSidebarNavGroupHeight({ requestedHeight, viewportHeight });
  const [measuredHeight, setMeasuredHeight] = useState<number | null>(null);
  const rowsStyle = useMemo(
    () => [styles.rows, requestedHeight === null ? { maxHeight: height } : { height }],
    [height, requestedHeight],
  );
  const handleRowsLayout = useCallback(
    (event: { nativeEvent: { layout: { height: number } } }) =>
      setMeasuredHeight(event.nativeEvent.layout.height),
    [],
  );
  const commitHeight = useCallback(
    (nextHeight: number) => {
      setStoredHeight(
        resolveSidebarNavGroupHeight({ requestedHeight: nextHeight, viewportHeight }),
      );
      setDraggedHeight(null);
    },
    [setStoredHeight, viewportHeight],
  );

  if (visibleItems.length === 0) return null;

  return (
    <View style={style} testID="sidebar-nav-group">
      <SidebarSectionHeader
        title={t("sidebar.nav.title")}
        collapsed={collapsed}
        onToggle={toggleCollapsed}
        testID="sidebar-nav-group-header"
      />
      {collapsed ? null : (
        <SidebarNavResizeHandle
          height={measuredHeight ?? height}
          onPreviewHeight={setDraggedHeight}
          onCommitHeight={commitHeight}
        />
      )}
      {collapsed ? null : (
        <ScrollView
          style={rowsStyle}
          onLayout={handleRowsLayout}
          contentContainerStyle={styles.rowsContent}
          showsVerticalScrollIndicator={false}
          testID="sidebar-nav-group-rows"
        >
          {visibleItems.map((item) => {
            if (item.kind === "plugin") {
              return (
                <PluginSidebarItemRow
                  key={item.key}
                  group={item.group}
                  onBeforeNavigate={onBeforeNavigate}
                />
              );
            }
            const Row = BUILTIN_ROWS[item.id];
            return <Row key={item.key} onBeforeNavigate={onBeforeNavigate} />;
          })}
        </ScrollView>
      )}
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

const styles = StyleSheet.create(() => ({
  rows: {
    flexGrow: 0,
    flexShrink: 1,
  },
  // Same row rhythm the wrapper used before the rows moved inside the scroller.
  rowsContent: {
    gap: 2,
  },
}));
