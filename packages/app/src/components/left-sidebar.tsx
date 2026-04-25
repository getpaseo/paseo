import {
  memo,
  useCallback,
  useMemo,
  useState,
  useEffect,
  useRef,
  type Dispatch,
  type ReactElement,
  type RefObject,
  type SetStateAction,
} from "react";
import {
  View,
  Pressable,
  ScrollView,
  Text,
  useWindowDimensions,
  StyleSheet as RNStyleSheet,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Animated, {
  useAnimatedStyle,
  interpolate,
  Extrapolation,
  runOnJS,
  useSharedValue,
} from "react-native-reanimated";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import {
  Boxes,
  ChevronDown,
  ChevronRight,
  Folder,
  MessageSquare,
  MessagesSquare,
  PanelLeftClose,
  PanelLeftOpen,
  Lock,
  Plug,
  Plus,
  Puzzle,
  Settings,
  Share2,
  Sparkles,
  Users,
} from "lucide-react-native";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Shortcut } from "@/components/ui/shortcut";
import { useShortcutKeys } from "@/hooks/use-shortcut-keys";
import { router, usePathname } from "expo-router";
import { usePanelStore, MIN_SIDEBAR_WIDTH, MAX_SIDEBAR_WIDTH } from "@/stores/panel-store";
import { SidebarWorkspaceList } from "./sidebar-workspace-list";
import { SidebarSharedWorkspaces } from "./sidebar-shared-workspaces";
import { SidebarAgentListSkeleton } from "./sidebar-agent-list-skeleton";
import { useSidebarShortcutModel } from "@/hooks/use-sidebar-shortcut-model";
import {
  useSidebarWorkspacesList,
  type SidebarProjectEntry,
} from "@/hooks/use-sidebar-workspaces-list";
import { useSidebarAnimation } from "@/contexts/sidebar-animation-context";
import { useWindowControlsPadding } from "@/utils/desktop-window";
import { TitlebarDragRegion } from "@/components/desktop/titlebar-drag-region";
import { Combobox, ComboboxItem, type ComboboxOption } from "@/components/ui/combobox";
import { useHostRuntimeSnapshot, useHosts } from "@/runtime/host-runtime";
import { formatConnectionStatus } from "@/utils/daemons";
import {
  HEADER_INNER_HEIGHT,
  HEADER_INNER_HEIGHT_MOBILE,
  useIsCompactFormFactor,
} from "@/constants/layout";
import {
  buildHostSessionsRoute,
  buildHostSettingsRoute,
  mapPathnameToServer,
  parseServerIdFromPathname,
} from "@/utils/host-routes";
import { useOpenProjectPicker } from "@/hooks/use-open-project-picker";
import { navigateToWorkspace } from "@/hooks/use-workspace-navigation";
import { useKeyboardShortcutsStore } from "@/stores/keyboard-shortcuts-store";
import { useIsInSharedSession } from "@/stores/shared-session-store";
import { isWeb, getIsElectron } from "@/constants/platform";
import { useAuthSession } from "@/desktop/hooks/use-auth-session";
import { useActiveOrgId } from "@/stores/active-org-store";

/**
 * Decide what label, if any, to show next to the PROJECTS count so the user
 * knows where these projects "live":
 *   - signed out → projects are stored only on this machine, no sync; show
 *     "Local-only". When the user later signs in and creates/joins an org,
 *     the project-registry sync hook automatically uploads them.
 *   - signed in but no active org → same story; the upload waits for an org.
 *   - signed in with an active org → no tag; the section header is enough.
 */
function resolveProjectsScopeLabel(input: {
  isAuthenticated: boolean;
  activeOrgId: string | null;
}): { label: string; tooltip: string } | null {
  if (!input.isAuthenticated) {
    return {
      label: "Local-only",
      tooltip:
        "These projects exist only on this machine. Sign in and join an organization to share them with your team — your local list is preserved.",
    };
  }
  if (!input.activeOrgId) {
    return {
      label: "No org · local-only",
      tooltip:
        "You're signed in but haven't joined an organization yet. These projects stay local until you pick or create an org.",
    };
  }
  return null;
}
import { UpgradeBanner } from "@/desktop/components/upgrade-banner";
import { CompactOrgSwitcher } from "@/components/compact-org-switcher";
import { useSharedWorkspaceScope } from "@/stores/shared-session-store";

const MIN_CHAT_WIDTH = 400;

type SidebarShortcutModel = ReturnType<typeof useSidebarShortcutModel>;
type SidebarTheme = ReturnType<typeof useUnistyles>["theme"];

interface LeftSidebarProps {
  selectedAgentId?: string;
}

interface SidebarSharedProps {
  theme: SidebarTheme;
  activeServerId: string | null;
  activeHostLabel: string;
  activeHostStatusColor: string;
  hostOptions: ComboboxOption[];
  hostTriggerRef: RefObject<View | null>;
  isHostPickerOpen: boolean;
  setIsHostPickerOpen: Dispatch<SetStateAction<boolean>>;
  projects: SidebarProjectEntry[];
  isInitialLoad: boolean;
  isRevalidating: boolean;
  isManualRefresh: boolean;
  collapsedProjectKeys: SidebarShortcutModel["collapsedProjectKeys"];
  shortcutIndexByWorkspaceKey: SidebarShortcutModel["shortcutIndexByWorkspaceKey"];
  toggleProjectCollapsed: SidebarShortcutModel["toggleProjectCollapsed"];
  handleRefresh: () => void;
  handleHostSelect: (nextServerId: string) => void;
  handleOpenProject: () => void;
  handleSettings: () => void;
  renderHostOption: (input: {
    option: ComboboxOption;
    selected: boolean;
    active: boolean;
    onPress: () => void;
  }) => ReactElement;
  isScopedRecipient: boolean;
}

interface MobileSidebarProps extends SidebarSharedProps {
  insetsTop: number;
  insetsBottom: number;
  isOpen: boolean;
  closeToAgent: () => void;
  handleViewMoreNavigate: () => void;
}

interface DesktopSidebarProps extends SidebarSharedProps {
  insetsTop: number;
  isOpen: boolean;
  collapsed: boolean;
  onToggleCollapsed: () => void;
  handleViewMore: () => void;
}

export const LeftSidebar = memo(function LeftSidebar({
  selectedAgentId: _selectedAgentId,
}: LeftSidebarProps) {
  void _selectedAgentId;

  const { theme } = useUnistyles();
  const insets = useSafeAreaInsets();
  const isCompactLayout = useIsCompactFormFactor();
  const mobileView = usePanelStore((state) => state.mobileView);
  const desktopAgentListOpen = usePanelStore((state) => state.desktop.agentListOpen);
  const desktopAgentListCollapsed = usePanelStore((state) => state.desktop.agentListCollapsed);
  const toggleAgentListCollapsed = usePanelStore((state) => state.toggleAgentListCollapsed);
  const closeToAgent = usePanelStore((state) => state.closeToAgent);
  const pathname = usePathname();
  const daemons = useHosts();
  const activeServerIdFromPath = useMemo(() => parseServerIdFromPathname(pathname), [pathname]);
  const activeDaemon = useMemo(() => {
    if (daemons.length === 0) {
      return null;
    }
    if (activeServerIdFromPath) {
      const routeMatch = daemons.find((entry) => entry.serverId === activeServerIdFromPath);
      if (routeMatch) {
        return routeMatch;
      }
    }
    return daemons[0] ?? null;
  }, [activeServerIdFromPath, daemons]);
  const activeServerId = activeDaemon?.serverId ?? null;
  const activeHostLabel = useMemo(() => {
    if (!activeDaemon) return "No host";
    const trimmed = activeDaemon.label?.trim();
    return trimmed && trimmed.length > 0 ? trimmed : activeDaemon.serverId;
  }, [activeDaemon]);
  const activeHostSnapshot = useHostRuntimeSnapshot(activeServerId ?? "");
  const activeHostStatus = activeServerId
    ? (activeHostSnapshot?.connectionStatus ?? "connecting")
    : "idle";
  const activeHostStatusColor =
    activeHostStatus === "online"
      ? theme.colors.palette.green[400]
      : activeHostStatus === "connecting"
        ? theme.colors.palette.amber[500]
        : theme.colors.palette.red[500];
  const hostOptions = useMemo(
    () =>
      daemons.map((daemon) => ({
        id: daemon.serverId,
        label: daemon.label?.trim() || daemon.serverId,
      })),
    [daemons],
  );
  const renderHostOption = useCallback(
    ({
      option,
      selected,
      active,
      onPress,
    }: {
      option: ComboboxOption;
      selected: boolean;
      active: boolean;
      onPress: () => void;
    }) => (
      <HostSwitchOption
        serverId={option.id}
        label={option.label}
        selected={selected}
        active={active}
        onPress={onPress}
      />
    ),
    [],
  );
  const hostTriggerRef = useRef<View | null>(null);
  const [isHostPickerOpen, setIsHostPickerOpen] = useState(false);

  const isOpen = isCompactLayout ? mobileView === "agent-list" : desktopAgentListOpen;

  const { projects, isInitialLoad, isRevalidating, refreshAll } = useSidebarWorkspacesList({
    serverId: activeServerId,
    enabled: isOpen,
  });
  const { collapsedProjectKeys, shortcutIndexByWorkspaceKey, toggleProjectCollapsed } =
    useSidebarShortcutModel(projects);

  const [isManualRefresh, setIsManualRefresh] = useState(false);

  const handleRefresh = useCallback(() => {
    setIsManualRefresh(true);
    refreshAll();
  }, [refreshAll]);

  useEffect(() => {
    if (!isRevalidating && isManualRefresh) {
      setIsManualRefresh(false);
    }
  }, [isRevalidating, isManualRefresh]);

  const openProjectPicker = useOpenProjectPicker(activeServerId);

  const handleOpenProjectMobile = useCallback(() => {
    closeToAgent();
    void openProjectPicker();
  }, [closeToAgent, openProjectPicker]);

  const handleOpenProjectDesktop = useCallback(() => {
    void openProjectPicker();
  }, [openProjectPicker]);

  const handleSettingsMobile = useCallback(() => {
    if (!activeServerId) {
      return;
    }
    closeToAgent();
    router.push(buildHostSettingsRoute(activeServerId));
  }, [activeServerId, closeToAgent]);

  const handleSettingsDesktop = useCallback(() => {
    if (!activeServerId) {
      return;
    }
    router.push(buildHostSettingsRoute(activeServerId));
  }, [activeServerId]);

  const handleViewMoreNavigate = useCallback(() => {
    if (!activeServerId) {
      return;
    }
    router.push(buildHostSessionsRoute(activeServerId));
  }, [activeServerId]);

  const handleHostSelect = useCallback(
    (nextServerId: string) => {
      if (!nextServerId) {
        return;
      }
      const nextPath = mapPathnameToServer(pathname, nextServerId);
      setIsHostPickerOpen(false);
      router.push(nextPath);
    },
    [pathname],
  );

  const sharedScope = useSharedWorkspaceScope();
  const isScopedRecipient = sharedScope.workspaceId !== null;

  const sharedProps = {
    theme,
    activeServerId,
    activeHostLabel,
    activeHostStatusColor,
    hostOptions,
    hostTriggerRef,
    isHostPickerOpen,
    setIsHostPickerOpen,
    projects,
    isInitialLoad,
    isRevalidating,
    isManualRefresh,
    collapsedProjectKeys,
    shortcutIndexByWorkspaceKey,
    toggleProjectCollapsed,
    handleRefresh,
    handleHostSelect,
    renderHostOption,
    isScopedRecipient,
  };

  if (isCompactLayout) {
    return (
      <MobileSidebar
        {...sharedProps}
        insetsTop={insets.top}
        insetsBottom={insets.bottom}
        isOpen={isOpen}
        closeToAgent={closeToAgent}
        handleOpenProject={handleOpenProjectMobile}
        handleSettings={handleSettingsMobile}
        handleViewMoreNavigate={handleViewMoreNavigate}
      />
    );
  }

  return (
    <DesktopSidebar
      {...sharedProps}
      insetsTop={insets.top}
      isOpen={isOpen}
      collapsed={desktopAgentListCollapsed}
      onToggleCollapsed={toggleAgentListCollapsed}
      handleOpenProject={handleOpenProjectDesktop}
      handleSettings={handleSettingsDesktop}
      handleViewMore={handleViewMoreNavigate}
    />
  );
});

function HostSwitchOption({
  serverId,
  label,
  selected,
  active,
  onPress,
}: {
  serverId: string;
  label: string;
  selected: boolean;
  active: boolean;
  onPress: () => void;
}) {
  const snapshot = useHostRuntimeSnapshot(serverId);
  const connectionStatus = snapshot?.connectionStatus ?? "connecting";

  return (
    <ComboboxItem
      label={label}
      description={formatConnectionStatus(connectionStatus)}
      selected={selected}
      active={active}
      onPress={onPress}
    />
  );
}

function useLockedPromptSignIn(locked: boolean) {
  const { signIn } = useAuthSession();
  return useCallback(() => {
    if (!locked) return false;
    void signIn(undefined);
    return true;
  }, [locked, signIn]);
}

function ChatTabButton({
  onNavigate,
  locked = false,
  hidden = false,
}: {
  onNavigate?: () => void;
  locked?: boolean;
  /**
   * When the user is signed in but not a member of any organization, the
   * messages backend (mentions, channel members, pins) returns 403/404 for
   * every call. Hide the entry rather than showing a tab that can't load.
   * The user discovers it again the moment they create/join an org.
   */
  hidden?: boolean;
} = {}) {
  const { theme } = useUnistyles();
  const pathname = usePathname();
  const isActive = !locked && (pathname === "/chat" || pathname.startsWith("/chat/"));
  const promptSignIn = useLockedPromptSignIn(locked);
  // Conditional return goes AFTER hooks so React's hook order stays stable.
  if (hidden) return null;
  return (
    <Pressable
      onPress={() => {
        if (promptSignIn()) return;
        router.push("/chat");
        onNavigate?.();
      }}
      style={({ hovered }) => [
        styles.newAgentButton,
        hovered && styles.newAgentButtonHovered,
        isActive && styles.newAgentButtonActive,
        locked && styles.tabLocked,
      ]}
      accessibilityRole="button"
      accessibilityLabel={locked ? "Messages — sign in to unlock" : "Messages"}
    >
      {({ hovered }) => (
        <>
          <MessageSquare
            size={theme.iconSize.md}
            color={hovered || isActive ? theme.colors.brandMagenta : theme.colors.foregroundMuted}
          />
          <Text
            style={[
              styles.newAgentButtonText,
              (hovered || isActive) && styles.newAgentButtonTextHovered,
              isActive && { color: theme.colors.brandMagenta },
            ]}
          >
            Messages
          </Text>
          {locked ? (
            <Lock size={12} color={theme.colors.foregroundMuted} style={styles.tabLockIcon} />
          ) : null}
        </>
      )}
    </Pressable>
  );
}

function SessionsButton({ onPress, locked = false }: { onPress: () => void; locked?: boolean }) {
  const { theme } = useUnistyles();
  const pathname = usePathname();
  const isActive = !locked && pathname.includes("/sessions");
  const promptSignIn = useLockedPromptSignIn(locked);

  return (
    <Pressable
      style={({ hovered }) => [
        styles.newAgentButton,
        hovered && styles.newAgentButtonHovered,
        isActive && styles.newAgentButtonActive,
        locked && styles.tabLocked,
      ]}
      testID="sidebar-sessions"
      accessible
      accessibilityRole="button"
      accessibilityLabel={locked ? "Sessions — sign in to unlock" : "Sessions"}
      onPress={() => {
        if (promptSignIn()) return;
        onPress();
      }}
    >
      {({ hovered }) => (
        <>
          <MessagesSquare
            size={theme.iconSize.md}
            color={hovered || isActive ? theme.colors.foreground : theme.colors.foregroundMuted}
          />
          <Text
            style={[
              styles.newAgentButtonText,
              (hovered || isActive) && styles.newAgentButtonTextHovered,
            ]}
          >
            Sessions
          </Text>
          {locked ? (
            <Lock size={12} color={theme.colors.foregroundMuted} style={styles.tabLockIcon} />
          ) : null}
        </>
      )}
    </Pressable>
  );
}

/**
 * Library row — visually subordinate to the Messages/Sessions header tabs.
 * Single full-width row, icon-left, lighter background, matches the
 * sidebar's project-row aesthetic.
 */
function LibraryRow({
  label,
  icon,
  active,
  onPress,
  locked = false,
}: {
  label: string;
  icon: React.ReactNode;
  active: boolean;
  onPress: () => void;
  locked?: boolean;
}) {
  const { theme } = useUnistyles();
  return (
    <Pressable
      onPress={onPress}
      style={({ hovered, pressed }) => [
        styles.libraryRow,
        hovered && styles.libraryRowHovered,
        pressed && styles.libraryRowPressed,
        active && styles.libraryRowActive,
        locked && styles.tabLocked,
      ]}
      accessibilityRole="button"
      accessibilityLabel={locked ? `${label} — sign in to unlock` : label}
    >
      {icon}
      <Text style={[styles.libraryRowText, active && styles.libraryRowTextActive]}>{label}</Text>
      {locked ? (
        <Lock size={12} color={theme.colors.foregroundMuted} style={styles.tabLockIcon} />
      ) : null}
    </Pressable>
  );
}

/**
 * Collapsible "Projects" section. Mirrors the Shared Workspaces header —
 * chevron + icon + label + count on the left, `+` on the right — so the
 * sidebar reads as a coherent stack of groups.
 */
function ProjectsSection({
  count,
  onAdd,
  scopeLabel,
  scopeTooltip,
  children,
}: {
  count: number;
  onAdd?: () => void;
  /**
   * Inline tag rendered after the count. Used to disambiguate where the
   * projects belong when the user is signed out or hasn't joined an org —
   * those projects live only on this machine, and we surface "Local-only"
   * so the user understands they aren't synced anywhere yet.
   */
  scopeLabel?: string;
  scopeTooltip?: string;
  children: React.ReactNode;
}) {
  const { theme } = useUnistyles();
  const [collapsed, setCollapsed] = useState(false);
  if (count === 0) return <>{children}</>;
  return (
    <>
      <View style={styles.projectsSectionHeaderRow}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={collapsed ? "Expand projects" : "Collapse projects"}
          onPress={() => setCollapsed((prev) => !prev)}
          style={({ hovered = false }) => [
            styles.projectsSectionToggle,
            hovered && styles.projectsSectionHeaderHovered,
          ]}
        >
          {collapsed ? (
            <ChevronRight size={12} color={theme.colors.foregroundMuted} />
          ) : (
            <ChevronDown size={12} color={theme.colors.foregroundMuted} />
          )}
          <Boxes size={12} color={theme.colors.foregroundMuted} />
          <Text style={styles.projectsSectionText}>Projects</Text>
          <Text style={styles.projectsSectionCount}>{count}</Text>
          {scopeLabel ? (
            <Text style={styles.projectsScopeTag} accessibilityLabel={scopeTooltip ?? scopeLabel}>
              · {scopeLabel}
            </Text>
          ) : null}
        </Pressable>
        {onAdd ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Add project"
            onPress={onAdd}
            style={({ hovered = false }) => [
              styles.projectsSectionAdd,
              hovered && styles.projectsSectionHeaderHovered,
            ]}
          >
            <Plus size={12} color={theme.colors.foregroundMuted} />
          </Pressable>
        ) : null}
      </View>
      {!collapsed ? children : null}
    </>
  );
}

function SkillsTabButton({
  onNavigate,
  locked = false,
}: {
  onNavigate?: () => void;
  locked?: boolean;
} = {}) {
  const { theme } = useUnistyles();
  const pathname = usePathname();
  const isActive =
    !locked && (pathname === "/library/skills" || pathname.startsWith("/library/skills/"));
  const promptSignIn = useLockedPromptSignIn(locked);
  return (
    <LibraryRow
      label="Skills"
      locked={locked}
      icon={
        <Puzzle
          size={theme.iconSize.md}
          color={isActive ? theme.colors.foreground : theme.colors.foregroundMuted}
        />
      }
      active={isActive}
      onPress={() => {
        if (promptSignIn()) return;
        router.push("/library/skills" as never);
        onNavigate?.();
      }}
    />
  );
}

function McpTabButton({
  onNavigate,
  locked = false,
}: {
  onNavigate?: () => void;
  locked?: boolean;
} = {}) {
  const { theme } = useUnistyles();
  const pathname = usePathname();
  const isActive = !locked && (pathname === "/library/mcp" || pathname.startsWith("/library/mcp/"));
  const promptSignIn = useLockedPromptSignIn(locked);
  return (
    <LibraryRow
      label="MCP"
      locked={locked}
      icon={
        <Plug
          size={theme.iconSize.md}
          color={isActive ? theme.colors.foreground : theme.colors.foregroundMuted}
        />
      }
      active={isActive}
      onPress={() => {
        if (promptSignIn()) return;
        router.push("/library/mcp" as never);
        onNavigate?.();
      }}
    />
  );
}

function MobileSidebar({
  theme,
  activeServerId,
  activeHostLabel,
  activeHostStatusColor,
  hostOptions,
  hostTriggerRef,
  isHostPickerOpen,
  setIsHostPickerOpen,
  projects,
  isInitialLoad,
  isRevalidating,
  isManualRefresh,
  collapsedProjectKeys,
  shortcutIndexByWorkspaceKey,
  toggleProjectCollapsed,
  handleRefresh,
  handleHostSelect,
  renderHostOption,
  handleOpenProject,
  handleSettings,
  insetsTop,
  insetsBottom,
  isOpen,
  closeToAgent,
  handleViewMoreNavigate,
  isScopedRecipient,
}: MobileSidebarProps) {
  const newAgentKeys = useShortcutKeys("new-agent");
  const { isAuthenticated } = useAuthSession();
  const activeOrgId = useActiveOrgId();
  const projectsScope = resolveProjectsScopeLabel({ isAuthenticated, activeOrgId });
  const setTeamProjectsModalOpen = useKeyboardShortcutsStore((s) => s.setTeamProjectsModalOpen);
  const handleOpenTeamProjects = useCallback(() => {
    setTeamProjectsModalOpen(true);
  }, [setTeamProjectsModalOpen]);
  const {
    translateX,
    backdropOpacity,
    windowWidth,
    animateToOpen,
    animateToClose,
    isGesturing,
    gestureAnimatingRef,
    closeGestureRef,
  } = useSidebarAnimation();
  const closeTouchStartX = useSharedValue(0);
  const closeTouchStartY = useSharedValue(0);

  const handleCloseFromGesture = useCallback(() => {
    gestureAnimatingRef.current = true;
    closeToAgent();
  }, [closeToAgent, gestureAnimatingRef]);

  const handleViewMore = useCallback(() => {
    if (!activeServerId) {
      return;
    }
    translateX.value = -windowWidth;
    backdropOpacity.value = 0;
    closeToAgent();
    handleViewMoreNavigate();
  }, [
    activeServerId,
    backdropOpacity,
    closeToAgent,
    handleViewMoreNavigate,
    translateX,
    windowWidth,
  ]);

  const closeGesture = useMemo(
    () =>
      Gesture.Pan()
        .withRef(closeGestureRef)
        .enabled(isOpen)
        .manualActivation(true)
        .onTouchesDown((event) => {
          const touch = event.changedTouches[0];
          if (!touch) {
            return;
          }
          closeTouchStartX.value = touch.absoluteX;
          closeTouchStartY.value = touch.absoluteY;
        })
        .onTouchesMove((event, stateManager) => {
          const touch = event.changedTouches[0];
          if (!touch || event.numberOfTouches !== 1) {
            stateManager.fail();
            return;
          }

          const deltaX = touch.absoluteX - closeTouchStartX.value;
          const deltaY = touch.absoluteY - closeTouchStartY.value;
          const absDeltaX = Math.abs(deltaX);
          const absDeltaY = Math.abs(deltaY);

          if (deltaX >= 10) {
            stateManager.fail();
            return;
          }
          if (absDeltaY > 10 && absDeltaY > absDeltaX) {
            stateManager.fail();
            return;
          }
          if (deltaX <= -15 && absDeltaX > absDeltaY) {
            stateManager.activate();
          }
        })
        .onStart(() => {
          isGesturing.value = true;
        })
        .onUpdate((event) => {
          const newTranslateX = Math.min(0, Math.max(-windowWidth, event.translationX));
          translateX.value = newTranslateX;
          backdropOpacity.value = interpolate(
            newTranslateX,
            [-windowWidth, 0],
            [0, 1],
            Extrapolation.CLAMP,
          );
        })
        .onEnd((event) => {
          isGesturing.value = false;
          const shouldClose = event.translationX < -windowWidth / 3 || event.velocityX < -500;
          if (shouldClose) {
            animateToClose();
            runOnJS(handleCloseFromGesture)();
          } else {
            animateToOpen();
          }
        })
        .onFinalize(() => {
          isGesturing.value = false;
        }),
    [
      isOpen,
      closeGestureRef,
      closeTouchStartX,
      closeTouchStartY,
      isGesturing,
      windowWidth,
      translateX,
      backdropOpacity,
      animateToClose,
      animateToOpen,
      handleCloseFromGesture,
    ],
  );

  const mobileSidebarInsetStyle = useMemo(
    () => ({ width: windowWidth, paddingTop: insetsTop, paddingBottom: insetsBottom }),
    [windowWidth, insetsTop, insetsBottom],
  );

  const hostStatusDotStyle = useMemo(
    () => [styles.hostStatusDot, { backgroundColor: activeHostStatusColor }],
    [activeHostStatusColor],
  );

  const sidebarAnimatedStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: translateX.value }],
  }));

  const backdropAnimatedStyle = useAnimatedStyle(() => ({
    opacity: backdropOpacity.value,
    pointerEvents: backdropOpacity.value > 0.01 ? "auto" : "none",
  }));

  const overlayPointerEvents = isWeb ? (isOpen ? "auto" : "none") : "box-none";

  return (
    <View style={[StyleSheet.absoluteFillObject, { pointerEvents: overlayPointerEvents }]}>
      <Animated.View style={[staticStyles.backdrop, backdropAnimatedStyle]} />

      <GestureDetector gesture={closeGesture} touchAction="pan-y">
        <Animated.View
          style={[
            staticStyles.mobileSidebar,
            mobileSidebarInsetStyle,
            sidebarAnimatedStyle,
            { backgroundColor: theme.colors.surfaceSidebar, pointerEvents: "auto" },
          ]}
        >
          <View style={[styles.sidebarContent, { pointerEvents: "auto" }]}>
            {!isScopedRecipient && (
              <>
                {isAuthenticated ? (
                  <View style={styles.sidebarOrgSwitcher}>
                    <CompactOrgSwitcher onAfterSwitch={() => closeToAgent()} />
                  </View>
                ) : null}
                <View style={styles.sidebarHeader}>
                  <View style={styles.sidebarHeaderRow}>
                    <ChatTabButton
                      onNavigate={() => closeToAgent()}
                      locked={!isAuthenticated}
                      hidden={isAuthenticated && !activeOrgId}
                    />
                    <SessionsButton onPress={handleViewMore} />
                  </View>
                </View>
                <View style={styles.libraryGroup}>
                  <SkillsTabButton onNavigate={() => closeToAgent()} locked={!isAuthenticated} />
                  <McpTabButton onNavigate={() => closeToAgent()} locked={!isAuthenticated} />
                </View>
              </>
            )}

            {isInitialLoad ? (
              <SidebarAgentListSkeleton />
            ) : (
              <>
                {/* Shared workspaces are an org-level feature; hide entirely
                   when the user is signed in but isn't a member of any org —
                   the backend returns 403 for every shared-workspace endpoint.
                   The locked state still appears for signed-out users so they
                   discover the feature. */}
                {!isScopedRecipient &&
                  (isAuthenticated ? (
                    activeOrgId !== null && (
                      <SidebarSharedWorkspaces
                        serverId={activeServerId}
                        onWorkspacePress={() => closeToAgent()}
                      />
                    )
                  ) : (
                    <LockedSharedWorkspacesRow />
                  ))}
                <ProjectsSection
                  count={projects.length}
                  onAdd={isScopedRecipient ? undefined : handleOpenProject}
                  scopeLabel={projectsScope?.label}
                  scopeTooltip={projectsScope?.tooltip}
                >
                  <SidebarWorkspaceList
                    serverId={activeServerId}
                    collapsedProjectKeys={collapsedProjectKeys}
                    onToggleProjectCollapsed={toggleProjectCollapsed}
                    shortcutIndexByWorkspaceKey={shortcutIndexByWorkspaceKey}
                    projects={projects}
                    isRefreshing={isManualRefresh && isRevalidating}
                    onRefresh={handleRefresh}
                    onWorkspacePress={() => closeToAgent()}
                    onAddProject={isScopedRecipient ? undefined : handleOpenProject}
                    parentGestureRef={closeGestureRef}
                  />
                </ProjectsSection>
              </>
            )}

            {!isScopedRecipient && <SidebarSignInCard />}

            <View style={styles.sidebarFooter}>
              <View style={styles.footerHostSlot}>
                <Pressable
                  ref={hostTriggerRef}
                  style={({ hovered = false }) => [
                    styles.hostTrigger,
                    hovered && styles.hostTriggerHovered,
                  ]}
                  onPress={() => !isScopedRecipient && setIsHostPickerOpen(true)}
                  disabled={isScopedRecipient || hostOptions.length === 0}
                >
                  <View style={hostStatusDotStyle} />
                  <Text style={styles.hostTriggerText} numberOfLines={1}>
                    {activeHostLabel}
                  </Text>
                </Pressable>
              </View>
              {!isScopedRecipient && (
                <View style={styles.footerIconRow}>
                  <Tooltip delayDuration={300}>
                    <TooltipTrigger asChild>
                      <Pressable
                        style={styles.footerIconButton}
                        testID="sidebar-add-project"
                        nativeID="sidebar-add-project"
                        collapsable={false}
                        accessible
                        accessibilityLabel="Add project"
                        accessibilityRole="button"
                        onPress={handleOpenProject}
                      >
                        {({ hovered }) => (
                          <Plus
                            size={theme.iconSize.md}
                            color={hovered ? theme.colors.foreground : theme.colors.foregroundMuted}
                          />
                        )}
                      </Pressable>
                    </TooltipTrigger>
                    <TooltipContent side="top" align="center" offset={8}>
                      <View style={styles.tooltipRow}>
                        <Text style={styles.tooltipText}>Add project</Text>
                        {newAgentKeys ? <Shortcut chord={newAgentKeys} /> : null}
                      </View>
                    </TooltipContent>
                  </Tooltip>
                  <Tooltip delayDuration={300}>
                    <TooltipTrigger asChild>
                      <Pressable
                        style={styles.footerIconButton}
                        testID="sidebar-team-projects"
                        collapsable={false}
                        accessible
                        accessibilityLabel="Team projects"
                        accessibilityRole="button"
                        onPress={handleOpenTeamProjects}
                      >
                        {({ hovered }) => (
                          <Users
                            size={theme.iconSize.md}
                            color={hovered ? theme.colors.foreground : theme.colors.foregroundMuted}
                          />
                        )}
                      </Pressable>
                    </TooltipTrigger>
                    <TooltipContent side="top" align="center" offset={8}>
                      <Text style={styles.tooltipText}>Team projects</Text>
                    </TooltipContent>
                  </Tooltip>
                  <Pressable
                    style={styles.footerIconButton}
                    testID="sidebar-settings"
                    nativeID="sidebar-settings"
                    collapsable={false}
                    accessible
                    accessibilityLabel="Settings"
                    accessibilityRole="button"
                    onPress={handleSettings}
                  >
                    {({ hovered }) => (
                      <Settings
                        size={theme.iconSize.md}
                        color={hovered ? theme.colors.foreground : theme.colors.foregroundMuted}
                      />
                    )}
                  </Pressable>
                </View>
              )}
              <Combobox
                options={hostOptions}
                value={activeServerId ?? ""}
                onSelect={handleHostSelect}
                renderOption={renderHostOption}
                searchable={false}
                title="Switch host"
                searchPlaceholder="Search hosts..."
                open={isHostPickerOpen}
                onOpenChange={setIsHostPickerOpen}
                anchorRef={hostTriggerRef}
              />
            </View>
          </View>
        </Animated.View>
      </GestureDetector>
    </View>
  );
}

function SidebarSignInCard() {
  const { theme } = useUnistyles();
  const { isAuthenticated, signIn, isSigningIn } = useAuthSession();

  if (isAuthenticated) return null;

  return (
    <View style={styles.signInCard}>
      <View style={styles.signInCardHeader}>
        <Sparkles size={14} color={theme.colors.brandMagenta} />
        <Text style={styles.signInCardTitle}>Create your account</Text>
      </View>
      <Text style={styles.signInCardText}>
        Unlock exclusive tools: Messages, Skills, MCP and shared workspaces.
      </Text>
      <Pressable
        style={({ hovered = false }) => [
          styles.signInCardButton,
          hovered && styles.signInCardButtonHovered,
          isSigningIn && styles.signInCardButtonDisabled,
        ]}
        onPress={() => void signIn(undefined)}
        disabled={isSigningIn}
      >
        <Text style={styles.signInCardButtonText}>
          {isSigningIn ? "Waiting..." : "Sign in / Create account"}
        </Text>
      </Pressable>
    </View>
  );
}

function SidebarUpgradeHint() {
  const isElectron = getIsElectron();
  const { isAuthenticated } = useAuthSession();

  if (!isElectron || !isAuthenticated) return null;

  return <UpgradeBanner compact title="Upgrade to Pro" />;
}

function CollapsedDesktopSidebar({
  theme,
  insetsTop,
  padding,
  sharedSessionActive,
  onExpand,
  onOpenChat,
  onOpenSessions,
  onOpenAddProject,
  onOpenTeamProjects,
  projects,
  activeServerId,
  isScopedRecipient,
  isAuthenticated,
}: {
  theme: SidebarTheme;
  insetsTop: number;
  padding: { top: number };
  sharedSessionActive: boolean;
  onExpand: () => void;
  onOpenChat: () => void;
  onOpenSessions: () => void;
  onOpenAddProject: () => void;
  onOpenTeamProjects: () => void;
  projects: SidebarProjectEntry[];
  activeServerId: string | null;
  isScopedRecipient: boolean;
  isAuthenticated: boolean;
}) {
  const pathname = usePathname();
  const isChatActive = pathname === "/chat" || pathname.startsWith("/chat/");
  const isSessionsActive = pathname.includes("/sessions");

  const openProject = (project: SidebarProjectEntry) => {
    if (!activeServerId) return;
    // Open the first workspace of the project (same default as the
    // expanded list). If the project has no workspaces, nothing to do.
    const first = project.workspaces[0];
    if (!first) return;
    navigateToWorkspace(activeServerId, first.workspaceId);
  };

  return (
    <View
      style={[
        staticStyles.desktopSidebar,
        styles.collapsedRail,
        { paddingTop: insetsTop, width: 56 },
      ]}
    >
      <View style={styles.collapsedRailInner}>
        <View style={styles.sidebarDragArea}>
          <TitlebarDragRegion />
          {padding.top > 0 && !sharedSessionActive ? (
            <View style={{ height: padding.top }} />
          ) : null}
        </View>
        {/* Top icon group */}
        <View style={styles.collapsedIconGroup}>
          <CollapsedRailIconBtn
            label="Expand sidebar"
            icon={
              <PanelLeftOpen size={18} color={theme.colors.foregroundMuted} strokeWidth={1.75} />
            }
            onPress={onExpand}
          />
          <View style={styles.collapsedDivider} />
          {!isScopedRecipient && (
            <>
              <CollapsedRailIconBtn
                label={isAuthenticated ? "Messages" : "Messages — sign in to unlock"}
                active={!isAuthenticated ? false : isChatActive}
                locked={!isAuthenticated}
                icon={
                  <MessageSquare
                    size={18}
                    color={isChatActive ? theme.colors.brandMagenta : theme.colors.foregroundMuted}
                    strokeWidth={1.75}
                  />
                }
                onPress={onOpenChat}
              />
              <CollapsedRailIconBtn
                label="Sessions"
                active={isSessionsActive}
                icon={
                  <MessagesSquare
                    size={18}
                    color={
                      isSessionsActive ? theme.colors.foreground : theme.colors.foregroundMuted
                    }
                    strokeWidth={1.75}
                  />
                }
                onPress={onOpenSessions}
              />
              <CollapsedRailIconBtn
                label={
                  isAuthenticated ? "Shared workspaces" : "Shared workspaces — sign in to unlock"
                }
                locked={!isAuthenticated}
                icon={<Share2 size={18} color={theme.colors.foregroundMuted} strokeWidth={1.75} />}
                onPress={onOpenTeamProjects}
              />
              {projects.length > 0 ? <View style={styles.collapsedDivider} /> : null}
            </>
          )}
        </View>
        {/* Scrollable projects list — each project becomes a monogram chip. */}
        {!isScopedRecipient && projects.length > 0 ? (
          <ScrollView
            style={styles.collapsedProjects}
            contentContainerStyle={styles.collapsedProjectsContent}
            showsVerticalScrollIndicator={false}
          >
            {projects.map((project) => (
              <CollapsedProjectMonogram
                key={project.projectKey}
                project={project}
                onPress={() => openProject(project)}
                theme={theme}
              />
            ))}
          </ScrollView>
        ) : (
          <View style={{ flex: 1 }} />
        )}
        {/* Footer icon group pinned to bottom */}
        <View style={styles.collapsedFooter}>
          {!isScopedRecipient && (
            <>
              <CollapsedRailIconBtn
                label="Add project"
                icon={<Plus size={18} color={theme.colors.foregroundMuted} strokeWidth={2} />}
                onPress={onOpenAddProject}
              />
              <CollapsedRailIconBtn
                label="Team projects"
                icon={<Users size={18} color={theme.colors.foregroundMuted} strokeWidth={1.75} />}
                onPress={onOpenTeamProjects}
              />
            </>
          )}
        </View>
      </View>
    </View>
  );
}

function CollapsedProjectMonogram({
  project,
  onPress,
  theme,
}: {
  project: SidebarProjectEntry;
  onPress: () => void;
  theme: SidebarTheme;
}) {
  const initial = (project.projectName || "?").slice(0, 1).toUpperCase();
  return (
    <Tooltip delayDuration={0}>
      <TooltipTrigger asChild>
        <Pressable
          onPress={onPress}
          hitSlop={6}
          accessibilityRole="button"
          accessibilityLabel={`Open ${project.projectName}`}
          style={({ hovered, pressed }) => [
            styles.collapsedMonogram,
            hovered && styles.collapsedRailBtnHover,
            pressed && styles.collapsedRailBtnPressed,
          ]}
        >
          {project.totalWorkspaces > 0 ? (
            <Text style={styles.collapsedMonogramText}>{initial}</Text>
          ) : (
            <Folder size={16} color={theme.colors.foregroundMuted} strokeWidth={1.75} />
          )}
          {project.activeCount > 0 ? <View style={styles.collapsedMonogramDot} /> : null}
        </Pressable>
      </TooltipTrigger>
      <TooltipContent side="right" align="center" offset={8}>
        <Text style={styles.tooltipText}>{project.projectName}</Text>
      </TooltipContent>
    </Tooltip>
  );
}

function CollapsedRailIconBtn({
  label,
  icon,
  onPress,
  active,
  locked = false,
}: {
  label: string;
  icon: React.ReactNode;
  onPress: () => void;
  active?: boolean;
  locked?: boolean;
}) {
  const { theme } = useUnistyles();
  const promptSignIn = useLockedPromptSignIn(locked);
  return (
    <Tooltip delayDuration={0}>
      <TooltipTrigger asChild>
        <Pressable
          onPress={() => {
            if (promptSignIn()) return;
            onPress();
          }}
          hitSlop={6}
          accessibilityRole="button"
          accessibilityLabel={label}
          style={({ hovered, pressed }) => [
            styles.collapsedRailBtn,
            active && styles.collapsedRailBtnActive,
            !active && hovered && styles.collapsedRailBtnHover,
            pressed && styles.collapsedRailBtnPressed,
            locked && styles.tabLocked,
          ]}
        >
          {icon}
          {locked ? (
            <View style={styles.collapsedLockBadge}>
              <Lock size={8} color={theme.colors.foregroundMuted} />
            </View>
          ) : null}
        </Pressable>
      </TooltipTrigger>
      <TooltipContent side="right" align="center" offset={8}>
        <Text style={styles.tooltipText}>{label}</Text>
      </TooltipContent>
    </Tooltip>
  );
}

function LockedSharedWorkspacesRow() {
  const { theme } = useUnistyles();
  const { signIn } = useAuthSession();
  return (
    <View style={styles.projectsSectionHeaderRow}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Shared workspaces — sign in to unlock"
        onPress={() => void signIn(undefined)}
        style={({ hovered = false }) => [
          styles.projectsSectionToggle,
          hovered && styles.projectsSectionHeaderHovered,
          styles.tabLocked,
        ]}
      >
        <Share2 size={12} color={theme.colors.foregroundMuted} />
        <Text style={styles.projectsSectionText}>Shared workspaces</Text>
        <Lock size={10} color={theme.colors.foregroundMuted} style={styles.tabLockIcon} />
      </Pressable>
    </View>
  );
}

function DesktopSidebar({
  theme,
  activeServerId,
  activeHostLabel,
  activeHostStatusColor,
  hostOptions,
  hostTriggerRef,
  isHostPickerOpen,
  setIsHostPickerOpen,
  projects,
  isInitialLoad,
  isRevalidating,
  isManualRefresh,
  collapsedProjectKeys,
  shortcutIndexByWorkspaceKey,
  toggleProjectCollapsed,
  handleRefresh,
  handleHostSelect,
  renderHostOption,
  handleOpenProject,
  handleSettings,
  insetsTop,
  isOpen,
  collapsed,
  onToggleCollapsed,
  handleViewMore,
  isScopedRecipient,
}: DesktopSidebarProps) {
  const newAgentKeys = useShortcutKeys("new-agent");
  const { isAuthenticated } = useAuthSession();
  const activeOrgId = useActiveOrgId();
  const projectsScope = resolveProjectsScopeLabel({ isAuthenticated, activeOrgId });
  const padding = useWindowControlsPadding("sidebar");
  const sharedSessionActive = useIsInSharedSession();
  const setTeamProjectsModalOpen = useKeyboardShortcutsStore((s) => s.setTeamProjectsModalOpen);
  const handleOpenTeamProjects = useCallback(() => {
    setTeamProjectsModalOpen(true);
  }, [setTeamProjectsModalOpen]);
  const sidebarWidth = usePanelStore((state) => state.sidebarWidth);
  const setSidebarWidth = usePanelStore((state) => state.setSidebarWidth);
  const { width: viewportWidth } = useWindowDimensions();
  const hostStatusDotStyle = useMemo(
    () => [styles.hostStatusDot, { backgroundColor: activeHostStatusColor }],
    [activeHostStatusColor],
  );

  const startWidthRef = useRef(sidebarWidth);
  const resizeWidth = useSharedValue(sidebarWidth);

  useEffect(() => {
    resizeWidth.value = sidebarWidth;
  }, [sidebarWidth, resizeWidth]);

  const resizeGesture = useMemo(
    () =>
      Gesture.Pan()
        .hitSlop({ left: 8, right: 8, top: 0, bottom: 0 })
        .onStart(() => {
          startWidthRef.current = sidebarWidth;
          resizeWidth.value = sidebarWidth;
        })
        .onUpdate((event) => {
          // Dragging right (positive translationX) increases width
          const newWidth = startWidthRef.current + event.translationX;
          const maxWidth = Math.max(
            MIN_SIDEBAR_WIDTH,
            Math.min(MAX_SIDEBAR_WIDTH, viewportWidth - MIN_CHAT_WIDTH),
          );
          const clampedWidth = Math.max(MIN_SIDEBAR_WIDTH, Math.min(maxWidth, newWidth));
          resizeWidth.value = clampedWidth;
        })
        .onEnd(() => {
          runOnJS(setSidebarWidth)(resizeWidth.value);
        }),
    [sidebarWidth, resizeWidth, setSidebarWidth, viewportWidth],
  );

  const resizeAnimatedStyle = useAnimatedStyle(() => ({
    width: resizeWidth.value,
  }));

  if (!isOpen) {
    return null;
  }

  if (collapsed) {
    return (
      <CollapsedDesktopSidebar
        theme={theme}
        insetsTop={insetsTop}
        padding={padding}
        sharedSessionActive={sharedSessionActive}
        onExpand={onToggleCollapsed}
        onOpenChat={() => router.push("/chat")}
        onOpenSessions={handleViewMore}
        onOpenAddProject={handleOpenProject}
        onOpenTeamProjects={handleOpenTeamProjects}
        projects={projects}
        activeServerId={activeServerId}
        isScopedRecipient={isScopedRecipient}
        isAuthenticated={isAuthenticated}
      />
    );
  }

  return (
    <Animated.View
      style={[staticStyles.desktopSidebar, resizeAnimatedStyle, { paddingTop: insetsTop }]}
    >
      <View style={[styles.desktopSidebarBorder, { flex: 1 }]}>
        <View style={styles.sidebarDragArea}>
          <TitlebarDragRegion />
          {/* Always reserve at least 8px under the magenta DesktopTitlebarAccent
              so the tabs don't visually collide with it. When there's no
              shared session we also clear the full traffic-light height. */}
          <View
            style={{
              height: sharedSessionActive ? 8 : Math.max(padding.top, 8),
            }}
          />
          {!isScopedRecipient && (
            <>
              <View style={styles.sidebarHeader}>
                <View style={styles.sidebarHeaderRow}>
                  <ChatTabButton
                    locked={!isAuthenticated}
                    hidden={isAuthenticated && !activeOrgId}
                  />
                  <SessionsButton onPress={handleViewMore} />
                </View>
              </View>
              <View style={styles.libraryGroup}>
                <SkillsTabButton locked={!isAuthenticated} />
                <McpTabButton locked={!isAuthenticated} />
              </View>
            </>
          )}
        </View>

        {isInitialLoad ? (
          <SidebarAgentListSkeleton />
        ) : (
          <>
            {!isScopedRecipient &&
              (isAuthenticated ? (
                activeOrgId !== null && <SidebarSharedWorkspaces serverId={activeServerId} />
              ) : (
                <LockedSharedWorkspacesRow />
              ))}
            <ProjectsSection
              count={projects.length}
              onAdd={isScopedRecipient ? undefined : handleOpenProject}
              scopeLabel={projectsScope?.label}
              scopeTooltip={projectsScope?.tooltip}
            >
              <SidebarWorkspaceList
                serverId={activeServerId}
                collapsedProjectKeys={collapsedProjectKeys}
                onToggleProjectCollapsed={toggleProjectCollapsed}
                shortcutIndexByWorkspaceKey={shortcutIndexByWorkspaceKey}
                projects={projects}
                isRefreshing={isManualRefresh && isRevalidating}
                onRefresh={handleRefresh}
                onAddProject={isScopedRecipient ? undefined : handleOpenProject}
              />
            </ProjectsSection>
          </>
        )}

        {!isScopedRecipient && <SidebarSignInCard />}
        {!isScopedRecipient && <SidebarUpgradeHint />}

        <View style={styles.sidebarFooter}>
          <View style={styles.footerHostSlot}>
            <Pressable
              ref={hostTriggerRef}
              style={({ hovered = false }) => [
                styles.hostTrigger,
                hovered && styles.hostTriggerHovered,
              ]}
              onPress={() => !isScopedRecipient && setIsHostPickerOpen(true)}
              disabled={isScopedRecipient || hostOptions.length === 0}
            >
              <View style={hostStatusDotStyle} />
              <Text style={styles.hostTriggerText} numberOfLines={1}>
                {activeHostLabel}
              </Text>
            </Pressable>
          </View>
          {!isScopedRecipient && (
            <View style={styles.footerIconRow}>
              <Tooltip delayDuration={300}>
                <TooltipTrigger asChild>
                  <Pressable
                    style={styles.footerIconButton}
                    testID="sidebar-add-project"
                    nativeID="sidebar-add-project"
                    collapsable={false}
                    accessible
                    accessibilityLabel="Add project"
                    accessibilityRole="button"
                    onPress={handleOpenProject}
                  >
                    {({ hovered }) => (
                      <Plus
                        size={theme.iconSize.md}
                        color={hovered ? theme.colors.foreground : theme.colors.foregroundMuted}
                      />
                    )}
                  </Pressable>
                </TooltipTrigger>
                <TooltipContent side="top" align="center" offset={8}>
                  <View style={styles.tooltipRow}>
                    <Text style={styles.tooltipText}>Add project</Text>
                    {newAgentKeys ? <Shortcut chord={newAgentKeys} /> : null}
                  </View>
                </TooltipContent>
              </Tooltip>
              <Tooltip delayDuration={300}>
                <TooltipTrigger asChild>
                  <Pressable
                    style={styles.footerIconButton}
                    accessible
                    accessibilityLabel="Collapse sidebar"
                    accessibilityRole="button"
                    onPress={onToggleCollapsed}
                  >
                    {({ hovered }) => (
                      <PanelLeftClose
                        size={theme.iconSize.md}
                        color={hovered ? theme.colors.foreground : theme.colors.foregroundMuted}
                      />
                    )}
                  </Pressable>
                </TooltipTrigger>
                <TooltipContent side="top" align="center" offset={8}>
                  <Text style={styles.tooltipText}>Collapse sidebar</Text>
                </TooltipContent>
              </Tooltip>
            </View>
          )}
          <Combobox
            options={hostOptions}
            value={activeServerId ?? ""}
            onSelect={handleHostSelect}
            renderOption={renderHostOption}
            searchable={false}
            title="Switch host"
            searchPlaceholder="Search hosts..."
            open={isHostPickerOpen}
            onOpenChange={setIsHostPickerOpen}
            anchorRef={hostTriggerRef}
          />
        </View>

        {/* Resize handle - absolutely positioned over right border */}
        <GestureDetector gesture={resizeGesture}>
          <View style={[styles.resizeHandle, isWeb && ({ cursor: "col-resize" } as any)]} />
        </GestureDetector>
      </View>
    </Animated.View>
  );
}

// Static styles for Animated.Views — must NOT use Unistyles dynamic theme to
// avoid the "Unable to find node on an unmounted component" crash when Unistyles
// tries to patch the native node that Reanimated also manages.
const staticStyles = RNStyleSheet.create({
  backdrop: {
    ...RNStyleSheet.absoluteFillObject,
    backgroundColor: "rgba(0, 0, 0, 0.5)",
  },
  mobileSidebar: {
    position: "absolute" as const,
    top: 0,
    left: 0,
    bottom: 0,
    overflow: "hidden" as const,
  },
  desktopSidebar: {
    position: "relative" as const,
  },
});

const styles = StyleSheet.create((theme) => ({
  sidebarContent: {
    flex: 1,
    minHeight: 0,
  },
  desktopSidebarBorder: {
    borderRightWidth: 1,
    borderRightColor: theme.colors.border,
    backgroundColor: theme.colors.surfaceSidebar,
  },
  collapsedRail: {
    borderRightWidth: 1,
    borderRightColor: theme.colors.border,
    backgroundColor: theme.colors.surfaceSidebar,
  },
  collapsedRailInner: {
    flex: 1,
    alignItems: "center",
    paddingVertical: theme.spacing[2],
    gap: 4,
  },
  collapsedIconGroup: {
    alignItems: "center",
    gap: 4,
    paddingTop: theme.spacing[2],
  },
  collapsedDivider: {
    width: 24,
    height: 1,
    backgroundColor: theme.colors.border,
    marginVertical: theme.spacing[1],
  },
  collapsedFooter: {
    marginTop: "auto",
    alignItems: "center",
    gap: 4,
    paddingBottom: theme.spacing[2],
  },
  collapsedRailBtn: {
    width: 36,
    height: 36,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 8,
  },
  collapsedRailBtnActive: {
    backgroundColor: theme.colors.rowSelected,
  },
  collapsedRailBtnHover: {
    backgroundColor: theme.colors.rowHover,
  },
  collapsedRailBtnPressed: {
    backgroundColor: theme.colors.rowPressed,
  },
  collapsedProjects: {
    flex: 1,
    alignSelf: "stretch",
  },
  collapsedProjectsContent: {
    alignItems: "center",
    gap: 4,
    paddingVertical: theme.spacing[2],
  },
  collapsedMonogram: {
    width: 36,
    height: 36,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 8,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
    position: "relative",
  },
  collapsedMonogramText: {
    fontSize: 13,
    fontWeight: "700",
    color: theme.colors.foreground,
  },
  collapsedMonogramDot: {
    position: "absolute",
    top: 2,
    right: 2,
    width: 7,
    height: 7,
    borderRadius: 4,
    backgroundColor: theme.colors.brandMagenta,
  },
  resizeHandle: {
    position: "absolute",
    right: -5,
    top: 0,
    bottom: 0,
    width: 10,
    zIndex: 10,
  },
  sidebarDragArea: {
    position: "relative",
  },
  sidebarHeader: {
    height: {
      xs: HEADER_INNER_HEIGHT_MOBILE,
      md: HEADER_INNER_HEIGHT,
    },
    paddingHorizontal: theme.spacing[2],
    justifyContent: "center",
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
    userSelect: "none",
  },
  sidebarOrgSwitcher: {
    paddingHorizontal: theme.spacing[2],
    paddingTop: theme.spacing[2],
    paddingBottom: theme.spacing[2],
  },
  sidebarHeaderRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[2],
  },
  libraryGroup: {
    paddingHorizontal: theme.spacing[2],
    paddingTop: theme.spacing[2],
    paddingBottom: theme.spacing[2],
    marginBottom: theme.spacing[1],
    gap: 2,
    // Visually split the Skills/MCP group from the workspace sections below.
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
  },
  projectsSectionHeaderRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    marginHorizontal: theme.spacing[2],
    marginTop: theme.spacing[2],
  },
  projectsSectionToggle: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1] + 2,
    borderRadius: theme.borderRadius.base,
  },
  projectsSectionAdd: {
    width: 20,
    height: 20,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: theme.borderRadius.base,
  },
  projectsSectionHeaderHovered: {
    backgroundColor: theme.colors.surfaceSidebarHover,
  },
  projectsSectionText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.medium,
    textTransform: "uppercase",
    letterSpacing: 0.4,
  },
  projectsSectionCount: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
  },
  projectsScopeTag: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
    fontStyle: "italic",
    opacity: 0.85,
  },
  libraryRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingVertical: 6,
    paddingHorizontal: theme.spacing[2],
    borderRadius: theme.borderRadius.md,
    minHeight: 32,
  },
  libraryRowHovered: {
    backgroundColor: theme.colors.surfaceSidebarHover,
  },
  libraryRowPressed: {
    backgroundColor: theme.colors.rowPressed,
  },
  libraryRowActive: {
    backgroundColor: theme.colors.rowSelected,
  },
  libraryRowText: {
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foregroundMuted,
  },
  libraryRowTextActive: {
    color: theme.colors.foreground,
    fontWeight: theme.fontWeight.semibold,
  },
  newAgentButton: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingVertical: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    borderRadius: theme.borderRadius.lg,
  },
  newAgentButtonText: {
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.normal,
    color: theme.colors.foregroundMuted,
  },
  newAgentButtonTextHovered: {
    color: theme.colors.foreground,
  },
  newAgentButtonHovered: {
    backgroundColor: theme.colors.surfaceSidebarHover,
  },
  newAgentButtonActive: {
    backgroundColor: theme.colors.surfaceSidebarHover,
  },
  hostTrigger: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "flex-start",
    gap: theme.spacing[2],
    minWidth: 0,
    paddingVertical: theme.spacing[1],
    paddingHorizontal: theme.spacing[2],
    borderRadius: theme.borderRadius.lg,
  },
  hostTriggerHovered: {
    backgroundColor: theme.colors.surfaceSidebarHover,
  },
  hostStatusDot: {
    width: 8,
    height: 8,
    borderRadius: theme.borderRadius.full,
  },
  hostTriggerText: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
    flexShrink: 1,
    minWidth: 0,
  },
  sidebarFooter: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[3],
    borderTopWidth: 1,
    borderTopColor: theme.colors.border,
    // Anchor the host/settings strip at the bottom of the sidebar column
    // regardless of how much content (projects / shared workspaces) is
    // expanded above it.
    marginTop: "auto",
  },
  footerHostSlot: {
    flexGrow: 0,
    flexShrink: 1,
    minWidth: 0,
    marginRight: theme.spacing[2],
  },
  footerIconRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    flexShrink: 0,
  },
  footerIconButton: {
    width: 28,
    height: 28,
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: theme.spacing[1],
    paddingHorizontal: theme.spacing[1],
  },
  hostPickerList: {
    gap: theme.spacing[2],
  },
  hostPickerOption: {
    paddingVertical: theme.spacing[3],
    paddingHorizontal: theme.spacing[3],
    borderRadius: theme.borderRadius.lg,
    backgroundColor: theme.colors.surface2,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
  },
  hostPickerOptionText: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
  },
  hostPickerCancel: {
    paddingVertical: theme.spacing[3],
    paddingHorizontal: theme.spacing[3],
    borderRadius: theme.borderRadius.lg,
    backgroundColor: theme.colors.surface0,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    alignItems: "center",
  },
  hostPickerCancelText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  tooltipRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  tooltipText: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.popoverForeground,
  },
  signInCard: {
    marginHorizontal: theme.spacing[3],
    marginBottom: theme.spacing[2],
    padding: theme.spacing[3],
    backgroundColor: theme.colors.surface1,
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.lg,
    gap: theme.spacing[3],
  },
  tabLocked: {
    opacity: 0.55,
  },
  tabLockIcon: {
    marginLeft: theme.spacing[1],
  },
  collapsedLockBadge: {
    position: "absolute",
    right: 2,
    bottom: 2,
    width: 12,
    height: 12,
    borderRadius: 6,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: theme.colors.surface1,
  },
  signInCardHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  signInCardTitle: {
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.semibold,
    color: theme.colors.foreground,
  },
  signInCardText: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
    lineHeight: theme.fontSize.xs * 1.4,
  },
  signInCardButton: {
    alignSelf: "flex-start",
    paddingVertical: theme.spacing[1] + 2,
    paddingHorizontal: theme.spacing[3],
    backgroundColor: theme.colors.accent,
  },
  signInCardButtonHovered: {
    opacity: 0.85,
  },
  signInCardButtonDisabled: {
    opacity: 0.5,
  },
  signInCardButtonText: {
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.accentForeground,
  },
}));
