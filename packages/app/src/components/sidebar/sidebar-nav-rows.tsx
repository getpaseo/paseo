import { router, usePathname } from "expo-router";
import { CalendarClock, History, Plus, Search } from "lucide-react-native";
import { useCallback, useMemo, useRef, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { View, type StyleProp, type ViewStyle } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { HeaderToggleButton } from "@/components/headers/header-toggle-button";
import { SidebarHeaderRow, type SidebarRowIcon } from "@/components/sidebar/sidebar-header-row";
import { iconButtonChromeGlyphSize } from "@/components/ui/icon-button-chrome";
import { useAppSettings } from "@/hooks/use-settings";
import { useShortcutKeys } from "@/hooks/use-shortcut-keys";
import { PluginSidebarItem } from "@/plugins/sidebar-items";
import { canCreateWorktreeForProjectKind } from "@/projects/host-projects";
import { useHostFeature } from "@/runtime/host-features";
import {
  builtinSidebarNavLabelKey,
  builtinSidebarNavShortcutAction,
  type BuiltinSidebarNavId,
  type SidebarNavItem,
} from "@/sidebar-nav/model";
import { useSidebarNavItems } from "@/sidebar-nav/use-sidebar-nav-items";
import { useKeyboardShortcutsStore } from "@/stores/keyboard-shortcuts-store";
import { useActiveWorkspaceSelection } from "@/stores/navigation-active-workspace-store";
import { useWorkspace } from "@/stores/session-store-hooks";
import type { Theme } from "@/styles/theme";
import type { ShortcutKey } from "@/utils/format-shortcut";
import {
  buildNewWorkspaceRoute,
  buildSchedulesRoute,
  buildSessionsRoute,
} from "@/utils/host-routes";

const foregroundColorMapping = (theme: Theme) => ({ color: theme.colors.foreground });
const foregroundMutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

interface SidebarNavRowsProps {
  onBeforeNavigate?: () => void;
  /** Style for the group wrapper, which the sidebar owns. */
  style?: StyleProp<ViewStyle>;
  /**
   * Distance from the sidebar's right edge to the left edge of chrome it draws over the first
   * row, such as the mobile close button. The compact row's icons stop one icon gap before it.
   */
  trailingInset?: number;
}

/** What a builtin header item does, independent of whether it renders as a row or an icon. */
interface SidebarNavAction {
  icon: SidebarRowIcon;
  label: string;
  onPress: () => void;
  isActive: boolean;
  testID: string;
  shortcutKeys: ShortcutKey[][] | null;
}

type BuiltinNavItem = Extract<SidebarNavItem<"header">, { kind: "builtin" }>;
type PluginNavItem = Extract<SidebarNavItem<"header">, { kind: "plugin" }>;

/**
 * Top-level sidebar navigation, ordered and filtered by the user's
 * `sidebarNavItems` preference. Renders nothing — not even the bordered group
 * wrapper — when every item is hidden.
 *
 * The compact layout puts the first visible builtin on one row and the other builtins beside it
 * as icon buttons, outside the row's own hover and press area. Plugin items keep their own rows
 * below it.
 */
export function SidebarNavRows({ style, onBeforeNavigate, trailingInset }: SidebarNavRowsProps) {
  const { items } = useSidebarNavItems("header");
  const { settings } = useAppSettings();
  const actions = useBuiltinSidebarNavActions(onBeforeNavigate);
  const visibleItems = useMemo(() => items.filter((item) => item.visible), [items]);
  const groupRef = useRef<View | null>(null);

  if (visibleItems.length === 0) return null;

  const renderPluginItem = (item: PluginNavItem) => (
    <PluginSidebarItem
      key={item.key}
      group={item.group}
      section="header"
      fallbackAnchorRef={groupRef}
      onBeforeNavigate={onBeforeNavigate}
    />
  );

  if (settings.sidebarHeaderLayout === "compact") {
    const lead = visibleItems.find(isBuiltinNavItem);
    const rest = visibleItems.filter(isBuiltinNavItem).filter((item) => item !== lead);
    return (
      <View ref={groupRef} collapsable={false} style={style}>
        {lead ? (
          <CompactSidebarNavRow
            lead={actions[lead.id]}
            rest={rest.map((item) => actions[item.id])}
            trailingInset={trailingInset}
          />
        ) : null}
        {visibleItems.filter(isPluginNavItem).map(renderPluginItem)}
      </View>
    );
  }

  return (
    <View ref={groupRef} collapsable={false} style={style}>
      {visibleItems.map((item) =>
        item.kind === "plugin" ? (
          renderPluginItem(item)
        ) : (
          <SidebarNavActionRow key={item.key} action={actions[item.id]} />
        ),
      )}
    </View>
  );
}

function isBuiltinNavItem(item: SidebarNavItem<"header">): item is BuiltinNavItem {
  return item.kind === "builtin";
}

function isPluginNavItem(item: SidebarNavItem<"header">): item is PluginNavItem {
  return item.kind === "plugin";
}

function CompactSidebarNavRow({
  lead,
  rest,
  trailingInset,
}: {
  lead: SidebarNavAction;
  rest: readonly SidebarNavAction[];
  trailingInset: number | undefined;
}) {
  const actionsStyle = useMemo(
    () => [styles.compactActions, trailingInset ? styles.compactActionsInset(trailingInset) : null],
    [trailingInset],
  );
  const iconButtons = useMemo(
    () =>
      rest.length === 0 ? undefined : (
        <View style={actionsStyle}>
          {rest.map((action) => (
            <SidebarNavIconButton key={action.testID} action={action} />
          ))}
        </View>
      ),
    [actionsStyle, rest],
  );
  return <SidebarNavActionRow action={lead} actions={iconButtons} />;
}

function SidebarNavActionRow({
  action,
  actions,
}: {
  action: SidebarNavAction;
  actions?: ReactNode;
}) {
  return (
    <SidebarHeaderRow
      icon={action.icon}
      label={action.label}
      onPress={action.onPress}
      isActive={action.isActive}
      testID={action.testID}
      variant="compact"
      shortcutKeys={action.shortcutKeys}
      actions={actions}
    />
  );
}

function SidebarNavIconButton({ action }: { action: SidebarNavAction }) {
  const ThemedIcon = useMemo(() => withUnistyles(action.icon), [action.icon]);
  return (
    <HeaderToggleButton
      testID={action.testID}
      onPress={action.onPress}
      tooltipLabel={action.label}
      tooltipKeys={action.shortcutKeys?.[0] ?? []}
      tooltipSide="bottom"
      accessible
      accessibilityRole="button"
      accessibilityLabel={action.label}
      accessibilityState={action.isActive ? SELECTED_STATE : undefined}
    >
      {({ hovered }) => (
        <ThemedIcon
          size={iconButtonChromeGlyphSize("large")}
          uniProps={
            hovered || action.isActive ? foregroundColorMapping : foregroundMutedColorMapping
          }
        />
      )}
    </HeaderToggleButton>
  );
}

const SELECTED_STATE = { selected: true } as const;

function useBuiltinSidebarNavActions(
  onBeforeNavigate: (() => void) | undefined,
): Record<BuiltinSidebarNavId, SidebarNavAction> {
  const newWorkspace = useNewWorkspaceAction(onBeforeNavigate);
  const history = useRouteAction(onBeforeNavigate, {
    id: "history",
    icon: History,
    route: buildSessionsRoute,
    activePath: "/sessions",
    testID: "sidebar-sessions",
  });
  const search = useSearchAction(onBeforeNavigate);
  const schedules = useRouteAction(onBeforeNavigate, {
    id: "schedules",
    icon: CalendarClock,
    route: buildSchedulesRoute,
    activePath: "/schedules",
    testID: "sidebar-schedules",
  });
  return { "new-workspace": newWorkspace, history, search, schedules };
}

function useNewWorkspaceAction(onBeforeNavigate: (() => void) | undefined): SidebarNavAction {
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

  const onPress = useCallback(() => {
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

  return {
    icon: Plus,
    label: t(builtinSidebarNavLabelKey("new-workspace")),
    onPress,
    isActive: false,
    testID: "sidebar-global-new-workspace",
    shortcutKeys,
  };
}

function useSearchAction(onBeforeNavigate: (() => void) | undefined): SidebarNavAction {
  const { t } = useTranslation();
  const shortcutKeys = useShortcutKeys(builtinSidebarNavShortcutAction("search"));
  const setCommandCenterOpen = useKeyboardShortcutsStore((state) => state.setCommandCenterOpen);
  const onPress = useCallback(() => {
    onBeforeNavigate?.();
    setCommandCenterOpen(true);
  }, [onBeforeNavigate, setCommandCenterOpen]);

  return {
    icon: Search,
    label: t(builtinSidebarNavLabelKey("search")),
    onPress,
    isActive: false,
    testID: "sidebar-search",
    shortcutKeys,
  };
}

function useRouteAction(
  onBeforeNavigate: (() => void) | undefined,
  options: {
    id: "history" | "schedules";
    icon: SidebarRowIcon;
    route: () => Parameters<typeof router.push>[0];
    activePath: string;
    testID: string;
  },
): SidebarNavAction {
  const { t } = useTranslation();
  const pathname = usePathname();
  const { route } = options;
  const onPress = useCallback(() => {
    onBeforeNavigate?.();
    router.push(route());
  }, [onBeforeNavigate, route]);

  return {
    icon: options.icon,
    label: t(builtinSidebarNavLabelKey(options.id)),
    onPress,
    isActive: pathname.includes(options.activePath),
    testID: options.testID,
    shortcutKeys: null,
  };
}

const styles = StyleSheet.create((theme) => ({
  compactActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
  },
  // The header group and the row's actions slot each pad spacing[2] on the right.
  compactActionsInset: (inset: number) => ({
    marginRight: inset + theme.spacing[1] - theme.spacing[2] * 2,
  }),
}));
