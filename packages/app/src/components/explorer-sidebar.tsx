import { useCallback, useEffect, useMemo, useRef } from "react";
import {
  View,
  Text,
  Pressable,
  useWindowDimensions,
  StyleSheet as RNStyleSheet,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Animated, { useAnimatedStyle, useSharedValue, runOnJS } from "react-native-reanimated";
import { Gesture } from "react-native-gesture-handler";
import { StyleSheet, useUnistyles, withUnistyles } from "react-native-unistyles";
import { Puzzle, X } from "lucide-react-native";
import type { Theme } from "@/styles/theme";
import { useTranslation } from "react-i18next";
import {
  formatPrTabLabel,
  PullRequestPane,
  PullRequestPaneError,
  PullRequestPaneSkeleton,
  PullRequestTabIcon,
  usePrPaneData,
} from "@/git/pull-request-panel";
import { useCheckoutGitActionsStore } from "@/git/actions-store";
import type { UsePrPaneDataResult } from "@/git/pull-request-panel/use-data";
import { usePanelStore, selectIsFileExplorerOpen, type ExplorerTab } from "@/stores/panel-store";
import { useToast } from "@/contexts/toast-context";
import { useCloseFileExplorerGesture } from "@/mobile-panels/gestures";
import { MobilePanelOverlay } from "@/mobile-panels/presentation";
import { HEADER_INNER_HEIGHT } from "@/constants/layout";
import { GitDiffPane } from "@/git/diff-pane";
import { FileExplorerPane } from "./file-explorer-pane";
import { useKeyboardShiftStyle } from "@/hooks/use-keyboard-shift-style";
import { useHasOwnedWindowChromeObstruction, WindowChromeSafeArea } from "@/utils/desktop-window";
import { TitlebarDragRegion } from "@/components/desktop/titlebar-drag-region";
import { RetainedPanelActivity } from "@/components/retained-panel";
import { SidebarResizeHandle } from "@/components/sidebar-resize-handle";
import { buildWorkspaceAttachmentScopeKey } from "@/attachments/workspace-attachments-store";
import { resolveDesktopExplorerWidth } from "@/components/desktop-sidebar-layout";
import { useWorkspaceLayoutStore } from "@/stores/workspace-layout-store";
import { buildWorkspaceTabPersistenceKey } from "@/workspace-tabs/model";
import { resolveFocusedChatTarget } from "@/composer/focused-chat-target";
import { createWorkspaceFileAttachment } from "@/attachments/workspace-file";
import { useDraftStore } from "@/stores/draft-store";
import {
  resolveExplorerTab,
  resolvePluginSidebarTabs,
  useBoundedPluginsLoading,
  type PluginSidebarTab,
} from "@/components/explorer-tab-resolution";
import { usePluginEntry, usePlugins } from "@/plugins/queries";
import { PluginSandbox } from "@/plugins/sandbox";
import { fromPluginRelativePath, type PluginContext } from "@/plugins/bridge";

function logExplorerSidebar(_event: string, _details: Record<string, unknown>): void {}

interface ExplorerSidebarProps {
  serverId: string;
  workspaceId?: string | null;
  workspaceRoot: string;
  isGit: boolean;
  /**
   * The location shape, not a bare path: a sidebar plugin's `open-file` carries
   * an optional `lineStart` and dropping it here diverged from the file pane.
   */
  onOpenFile?: (location: { path: string; lineStart?: number }) => void;
}

interface ExplorerSidebarSharedState {
  explorerTab: ExplorerTab;
  handleTabPress: (tab: ExplorerTab) => void;
}

function useExplorerSidebarSharedState({
  serverId,
  workspaceRoot,
  isGit,
}: Pick<ExplorerSidebarProps, "serverId" | "workspaceRoot" | "isGit">): ExplorerSidebarSharedState {
  const explorerTab = usePanelStore((state) => state.explorerTab);
  const setExplorerTabForCheckout = usePanelStore((state) => state.setExplorerTabForCheckout);
  const handleTabPress = useCallback(
    (tab: ExplorerTab) => {
      setExplorerTabForCheckout({ serverId, cwd: workspaceRoot, isGit, tab });
    },
    [isGit, serverId, setExplorerTabForCheckout, workspaceRoot],
  );

  return { explorerTab, handleTabPress };
}

export function CompactExplorerSidebar({
  serverId,
  workspaceId,
  workspaceRoot,
  isGit,
  onOpenFile,
}: ExplorerSidebarProps) {
  const { theme } = useUnistyles();
  const insets = useSafeAreaInsets();
  const isOpen = usePanelStore((state) => selectIsFileExplorerOpen(state, { isCompact: true }));
  const showMobileAgent = usePanelStore((state) => state.showMobileAgent);
  const { explorerTab, handleTabPress } = useExplorerSidebarSharedState({
    serverId,
    workspaceRoot,
    isGit,
  });
  const { style: mobileKeyboardInsetStyle } = useKeyboardShiftStyle({
    mode: "padding",
    enabled: true,
  });
  const { gesture: closeGesture } = useCloseFileExplorerGesture();

  const handleClose = useCallback(
    (reason: string) => {
      logExplorerSidebar("handleClose", {
        reason,
        isOpen,
      });
      showMobileAgent();
    },
    [isOpen, showMobileAgent],
  );

  const handleHeaderClose = useCallback(() => handleClose("header-close-button"), [handleClose]);

  const mobileSidebarStyle = useMemo(
    () => [
      {
        paddingTop: insets.top,
        backgroundColor: theme.colors.surfaceSidebar,
      },
      mobileKeyboardInsetStyle,
    ],
    [insets.top, theme.colors.surfaceSidebar, mobileKeyboardInsetStyle],
  );

  return (
    <RetainedPanelActivity active={isOpen}>
      <MobilePanelOverlay
        panel="file-explorer"
        closeGesture={closeGesture}
        panelStyle={mobileSidebarStyle}
      >
        <ExplorerSidebarContent
          activeTab={explorerTab}
          onTabPress={handleTabPress}
          onClose={handleHeaderClose}
          serverId={serverId}
          workspaceId={workspaceId}
          workspaceRoot={workspaceRoot}
          isGit={isGit}
          isOpen={isOpen}
          onOpenFile={onOpenFile}
        />
      </MobilePanelOverlay>
    </RetainedPanelActivity>
  );
}

export function ExplorerSidebar({
  serverId,
  workspaceId,
  workspaceRoot,
  isGit,
  onOpenFile,
}: ExplorerSidebarProps) {
  const insets = useSafeAreaInsets();
  const explorerWidth = usePanelStore((state) => state.explorerWidth);
  const setExplorerWidth = usePanelStore((state) => state.setExplorerWidth);
  const isOpen = usePanelStore((state) => selectIsFileExplorerOpen(state, { isCompact: false }));
  const closeDesktopFileExplorer = usePanelStore((state) => state.closeDesktopFileExplorer);
  const { explorerTab, handleTabPress } = useExplorerSidebarSharedState({
    serverId,
    workspaceRoot,
    isGit,
  });
  const { width: viewportWidth } = useWindowDimensions();
  const visibleExplorerWidth = resolveDesktopExplorerWidth({
    requestedWidth: explorerWidth,
    viewportWidth,
  });
  const startWidthRef = useRef(visibleExplorerWidth);
  const resizeWidth = useSharedValue(visibleExplorerWidth);

  useEffect(() => {
    resizeWidth.value = visibleExplorerWidth;
  }, [resizeWidth, visibleExplorerWidth]);

  const handleDesktopClose = useCallback(() => {
    logExplorerSidebar("handleClose", {
      reason: "desktop-close-button",
      isOpen,
    });
    closeDesktopFileExplorer();
  }, [closeDesktopFileExplorer, isOpen]);

  const resizeGesture = useMemo(
    () =>
      Gesture.Pan()
        .enabled(true)
        .hitSlop({ left: 8, right: 8, top: 0, bottom: 0 })
        .onStart(() => {
          startWidthRef.current = visibleExplorerWidth;
          resizeWidth.value = visibleExplorerWidth;
        })
        .onUpdate((event) => {
          const newWidth = startWidthRef.current - event.translationX;
          resizeWidth.value = resolveDesktopExplorerWidth({
            requestedWidth: newWidth,
            viewportWidth,
          });
        })
        .onEnd(() => {
          runOnJS(setExplorerWidth)(resizeWidth.value);
        }),
    [resizeWidth, setExplorerWidth, viewportWidth, visibleExplorerWidth],
  );

  const resizeAnimatedStyle = useAnimatedStyle(() => ({
    width: resizeWidth.value,
  }));
  const desktopSidebarStyle = useMemo(
    () => [explorerStaticStyles.desktopSidebar, resizeAnimatedStyle, { paddingTop: insets.top }],
    [resizeAnimatedStyle, insets.top],
  );

  if (!isOpen) {
    return null;
  }

  return (
    <Animated.View style={desktopSidebarStyle}>
      <View style={[styles.desktopSidebarBorder, { flex: 1 }]}>
        <SidebarResizeHandle
          edge="left"
          gesture={resizeGesture}
          testID="explorer-sidebar-resize-handle"
        />

        <ExplorerSidebarContent
          activeTab={explorerTab}
          onTabPress={handleTabPress}
          onClose={handleDesktopClose}
          serverId={serverId}
          workspaceId={workspaceId}
          workspaceRoot={workspaceRoot}
          isGit={isGit}
          isOpen={isOpen}
          onOpenFile={onOpenFile}
        />
      </View>
    </Animated.View>
  );
}

interface ExplorerTabButtonProps {
  tab: ExplorerTab;
  active: boolean;
  label?: string;
  /** Untrusted labels (plugin titles) clamp to one line and a bounded width. */
  clampLabel?: boolean;
  onTabPress: (tab: ExplorerTab) => void;
  testID: string;
  children?: React.ReactNode;
}

function ExplorerTabButton({
  tab,
  active,
  label,
  clampLabel,
  onTabPress,
  testID,
  children,
}: ExplorerTabButtonProps) {
  const handlePress = useCallback(() => onTabPress(tab), [onTabPress, tab]);
  const tabStyle = useMemo(() => [styles.tab, active && styles.tabActive], [active]);
  const tabTextStyle = useMemo(
    () => [styles.tabText, active && styles.tabTextActive, clampLabel && styles.tabTextClamped],
    [active, clampLabel],
  );
  return (
    <Pressable testID={testID} style={tabStyle} onPress={handlePress}>
      {children}
      {label !== undefined ? (
        <Text style={tabTextStyle} numberOfLines={clampLabel ? 1 : undefined}>
          {label}
        </Text>
      ) : null}
    </Pressable>
  );
}

interface SidebarContentProps {
  activeTab: ExplorerTab;
  onTabPress: (tab: ExplorerTab) => void;
  onClose: () => void;
  serverId: string;
  workspaceId?: string | null;
  workspaceRoot: string;
  isGit: boolean;
  isOpen: boolean;
  onOpenFile?: (location: { path: string; lineStart?: number }) => void;
}

function ExplorerSidebarContent({
  activeTab,
  onTabPress,
  onClose,
  serverId,
  workspaceId,
  workspaceRoot,
  isGit,
  isOpen,
  onOpenFile,
}: SidebarContentProps) {
  const { theme } = useUnistyles();
  const { t } = useTranslation();
  const toast = useToast();
  const hasRightWindowControls = useHasOwnedWindowChromeObstruction("top-right");
  const canQueryPullRequest = isGit && Boolean(workspaceRoot);
  const prPane = usePrPaneData({
    serverId,
    cwd: workspaceRoot,
    enabled: canQueryPullRequest && isOpen,
    timelineEnabled: activeTab === "pr" && canQueryPullRequest && isOpen,
  });
  const hasPullRequest = prPane.prNumber !== null;
  const showPrTab = hasPullRequest || (activeTab === "pr" && prPane.isLoading);
  const { plugins, isLoading } = usePlugins(serverId);
  const pluginsLoading = useBoundedPluginsLoading({ isLoading, serverId });
  const pluginTabs = useMemo(() => resolvePluginSidebarTabs(plugins), [plugins]);
  const { resolvedTab, activePluginTab, pluginTabPending } = resolveExplorerTab({
    activeTab,
    isGit,
    showPrTab,
    pluginTabs,
    pluginsLoading,
  });
  const prTabLabel = formatPrTabLabel(prPane.prNumber);
  const refreshGitActions = useCheckoutGitActionsStore((s) => s.refresh);
  const handlePrRetry = useCallback(() => {
    refreshGitActions({ serverId, cwd: workspaceRoot }).catch((error) => {
      toast.error(error instanceof Error ? error.message : t("workspace.git.diff.failedRefresh"));
    });
  }, [refreshGitActions, serverId, t, toast, workspaceRoot]);
  const workspaceAttachmentScopeKey = useMemo(
    () => buildWorkspaceAttachmentScopeKey({ serverId, workspaceId, cwd: workspaceRoot }),
    [serverId, workspaceId, workspaceRoot],
  );

  return (
    <View style={styles.sidebarContent} pointerEvents="auto">
      {/* Header with tabs and close button */}
      <WindowChromeSafeArea
        placement="inline"
        horizontalPadding={theme.spacing[2]}
        style={styles.header}
        testID="explorer-header"
      >
        <TitlebarDragRegion />
        <View style={styles.tabsContainer}>
          {isGit && (
            <ExplorerTabButton
              tab="changes"
              active={resolvedTab === "changes"}
              label={t("workspace.tabs.explorer.changes")}
              onTabPress={onTabPress}
              testID="explorer-tab-changes"
            />
          )}
          <ExplorerTabButton
            tab="files"
            active={resolvedTab === "files"}
            label={t("workspace.tabs.explorer.files")}
            onTabPress={onTabPress}
            testID="explorer-tab-files"
          />
          {isGit && showPrTab && (
            <ExplorerTabButton
              tab="pr"
              active={resolvedTab === "pr"}
              label={prTabLabel}
              onTabPress={onTabPress}
              testID="explorer-tab-pr"
            >
              <PullRequestTabIcon
                forge={prPane.forge}
                size={13}
                color={
                  resolvedTab === "pr" ? theme.colors.foreground : theme.colors.foregroundMuted
                }
              />
            </ExplorerTabButton>
          )}
          <PluginTabButtons
            pluginTabs={pluginTabs}
            resolvedTab={resolvedTab}
            onTabPress={onTabPress}
          />
        </View>
        <View style={styles.headerRightSection}>
          {!hasRightWindowControls && (
            <Pressable
              onPress={onClose}
              style={styles.closeButton}
              testID="explorer-close"
              nativeID="explorer-close"
              accessible
              accessibilityRole="button"
              accessibilityLabel={t("workspace.tabs.explorer.close")}
              hitSlop={8}
            >
              {({ hovered, pressed }) => (
                <X
                  size={18}
                  color={
                    hovered || pressed ? theme.colors.foreground : theme.colors.foregroundMuted
                  }
                />
              )}
            </Pressable>
          )}
        </View>
      </WindowChromeSafeArea>

      {/* Content based on active tab */}
      <View style={styles.contentArea} testID="explorer-content-area">
        {resolvedTab === "changes" && (
          <ChangedFilesPane
            serverId={serverId}
            workspaceId={workspaceId}
            workspaceRoot={workspaceRoot}
            isOpen={isOpen}
            onOpenFile={onOpenFile}
          />
        )}
        {resolvedTab === "files" && (
          <FilesPane
            serverId={serverId}
            workspaceId={workspaceId}
            workspaceRoot={workspaceRoot}
            onOpenFile={onOpenFile}
          />
        )}
        {resolvedTab === "pr" && (
          <PrTabContent
            serverId={serverId}
            cwd={workspaceRoot}
            prPane={prPane}
            workspaceAttachmentScopeKey={workspaceAttachmentScopeKey}
            onRetry={handlePrRetry}
          />
        )}
        {pluginTabPending && (
          <View style={styles.pluginState}>
            <Text style={styles.pluginStateText}>{t("plugins.loading")}</Text>
          </View>
        )}
        {/* Gated on isOpen like the PR pane: on compact the sidebar stays
            mounted under RetainedPanelActivity, and a closed drawer must not
            keep a WebView running untrusted plugin JS. */}
        {activePluginTab && isOpen && (
          <PluginTabContent
            key={activePluginTab.tab}
            serverId={serverId}
            workspaceId={workspaceId ?? null}
            workspaceRoot={workspaceRoot}
            panel={activePluginTab}
            onOpenFile={onOpenFile}
          />
        )}
      </View>
    </View>
  );
}

const ThemedPuzzle = withUnistyles(Puzzle);
// Hoisted so the mapper identity is stable across renders.
const activePuzzleColor = (theme: Theme) => ({ color: theme.colors.foreground });
const mutedPuzzleColor = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

function PluginTabButtons({
  pluginTabs,
  resolvedTab,
  onTabPress,
}: {
  pluginTabs: readonly PluginSidebarTab[];
  resolvedTab: ExplorerTab;
  onTabPress: (tab: ExplorerTab) => void;
}) {
  return (
    <>
      {pluginTabs.map((panel) => (
        <ExplorerTabButton
          key={panel.tab}
          tab={panel.tab}
          active={resolvedTab === panel.tab}
          label={panel.title}
          clampLabel
          onTabPress={onTabPress}
          testID={`explorer-tab-${panel.tab}`}
        >
          {/* ponytail: one generic icon for every plugin. Honouring the
              manifest's Lucide icon name means bundling all of lucide;
              add a curated name→component map if plugins ask for it. */}
          <ThemedPuzzle
            size={13}
            uniProps={resolvedTab === panel.tab ? activePuzzleColor : mutedPuzzleColor}
          />
        </ExplorerTabButton>
      ))}
    </>
  );
}

function PluginTabContent({
  serverId,
  workspaceId,
  workspaceRoot,
  panel,
  onOpenFile,
}: {
  serverId: string;
  workspaceId: string | null;
  workspaceRoot: string;
  panel: PluginSidebarTab;
  onOpenFile?: (location: { path: string; lineStart?: number }) => void;
}) {
  const { t } = useTranslation();
  const entry = usePluginEntry({ serverId, pluginId: panel.pluginId, entry: panel.entry });
  const context = useMemo<PluginContext>(
    () => ({ kind: "sidebar-panel", cwd: workspaceRoot, workspaceId }),
    [workspaceRoot, workspaceId],
  );
  // `open-file` only yields workspace-relative paths; host consumers want the
  // absolute one.
  const handleOpenFile = useCallback(
    (input: { path: string; lineStart?: number }) =>
      onOpenFile?.({ ...input, path: fromPluginRelativePath(workspaceRoot, input.path) }),
    [onOpenFile, workspaceRoot],
  );
  if (entry.data === undefined) {
    return (
      <View style={styles.pluginState}>
        <Text style={styles.pluginStateText}>
          {entry.error
            ? t("plugins.errors.panelFailed", {
                plugin: panel.pluginName,
                reason: entry.error.message,
              })
            : t("plugins.panelLoading")}
        </Text>
      </View>
    );
  }

  return (
    <PluginSandbox
      html={entry.data}
      context={context}
      onOpenFile={handleOpenFile}
      testID={`plugin-sidebar-${panel.pluginId}`}
    />
  );
}

/**
 * Shared add-to-chat state for the changes/files panes: both expose an "add file
 * to chat" action that attaches the file to the focused chat's composer.
 * Available only when a workspace with a focused chat is available.
 */
function useAddFileToChat({
  serverId,
  workspaceId,
}: Pick<SidebarContentProps, "serverId" | "workspaceId">) {
  const workspaceKey = workspaceId
    ? buildWorkspaceTabPersistenceKey({ serverId, workspaceId })
    : null;
  const layout = useWorkspaceLayoutStore((state) =>
    workspaceKey ? state.layoutByWorkspace[workspaceKey] : undefined,
  );
  const focusTab = useWorkspaceLayoutStore((state) => state.focusTab);
  const focusedChat = useMemo(
    () => resolveFocusedChatTarget({ serverId, layout }),
    [serverId, layout],
  );
  const addFile = useCallback(
    (filePath: string) => {
      if (!focusedChat || !workspaceKey) {
        return;
      }
      void useDraftStore.getState().attachWorkspaceFile({
        draftKey: focusedChat.draftKey,
        attachment: createWorkspaceFileAttachment({ path: filePath }),
      });
      focusTab(workspaceKey, focusedChat.tabId);
    },
    [focusTab, focusedChat, workspaceKey],
  );
  return { addFile, canAddToChat: focusedChat !== null };
}

function ChangedFilesPane({
  serverId,
  workspaceId,
  workspaceRoot,
  isOpen,
  onOpenFile,
}: Pick<
  SidebarContentProps,
  "serverId" | "workspaceId" | "workspaceRoot" | "isOpen" | "onOpenFile"
>) {
  const { addFile, canAddToChat } = useAddFileToChat({ serverId, workspaceId });
  const openPath = usePathOpener(onOpenFile);
  return (
    <GitDiffPane
      serverId={serverId}
      workspaceId={workspaceId}
      cwd={workspaceRoot}
      enabled={isOpen}
      onOpenFile={openPath}
      onAddToChat={canAddToChat ? addFile : undefined}
    />
  );
}

function FilesPane({
  serverId,
  workspaceId,
  workspaceRoot,
  onOpenFile,
}: Pick<SidebarContentProps, "serverId" | "workspaceId" | "workspaceRoot" | "onOpenFile">) {
  const { addFile, canAddToChat } = useAddFileToChat({ serverId, workspaceId });
  const openPath = usePathOpener(onOpenFile);
  return (
    <FileExplorerPane
      serverId={serverId}
      workspaceId={workspaceId}
      workspaceRoot={workspaceRoot}
      onOpenFile={openPath}
      onAddToChat={canAddToChat ? addFile : undefined}
    />
  );
}

/** The file tree and diff panes only ever name a path; plugins also name a line. */
function usePathOpener(onOpenFile?: (location: { path: string; lineStart?: number }) => void) {
  return useCallback((path: string) => onOpenFile?.({ path }), [onOpenFile]);
}

interface PrTabContentProps {
  serverId: string;
  cwd: string;
  prPane: UsePrPaneDataResult;
  workspaceAttachmentScopeKey: string;
  onRetry: () => void;
}

function PrTabContent({
  serverId,
  cwd,
  prPane,
  workspaceAttachmentScopeKey,
  onRetry,
}: PrTabContentProps) {
  if (prPane.data) {
    return (
      <PullRequestPane
        serverId={serverId}
        cwd={cwd}
        data={prPane.data}
        activityLoading={prPane.activityLoading}
        workspaceAttachmentScopeKey={workspaceAttachmentScopeKey}
      />
    );
  }
  if (prPane.error) {
    return <PullRequestPaneError onRetry={onRetry} />;
  }
  return <PullRequestPaneSkeleton />;
}

// Static styles for Animated.Views — must NOT use Unistyles dynamic theme to
// avoid the "Unable to find node on an unmounted component" crash when Unistyles
// tries to patch the native node that Reanimated also manages.
const explorerStaticStyles = RNStyleSheet.create({
  desktopSidebar: {
    position: "relative" as const,
  },
});

const styles = StyleSheet.create((theme) => ({
  desktopSidebarBorder: {
    borderLeftWidth: 1,
    borderLeftColor: theme.colors.border,
    backgroundColor: theme.colors.surfaceSidebar,
  },
  sidebarContent: {
    flex: 1,
    minHeight: 0,
    overflow: "hidden",
  },
  header: {
    position: "relative",
    height: HEADER_INNER_HEIGHT,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
  },
  // Plugin titles are untrusted and the panel count is unbounded, so the row has
  // to give way to the close button and window controls instead of running into
  // them — on iOS an overflowing row is not clipped, it overlaps.
  tabsContainer: {
    flexDirection: "row",
    flexShrink: 1,
    minWidth: 0,
    overflow: "hidden",
    gap: theme.spacing[1],
  },
  tab: {
    flexDirection: "row",
    alignItems: "center",
    flexShrink: 1,
    minWidth: 0,
    gap: theme.spacing[2],
    paddingVertical: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    borderRadius: theme.borderRadius.md,
  },
  tabActive: {
    backgroundColor: theme.colors.surfaceSidebarHover,
  },
  tabText: {
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.normal,
    color: theme.colors.foregroundMuted,
  },
  tabTextActive: {
    color: theme.colors.foreground,
  },
  tabTextMuted: {
    opacity: 0.8,
  },
  tabTextClamped: {
    flexShrink: 1,
    maxWidth: 120,
  },
  headerRightSection: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  closeButton: {
    padding: theme.spacing[2],
    borderRadius: theme.borderRadius.md,
  },
  contentArea: {
    flex: 1,
    minHeight: 0,
  },
  pluginState: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: theme.spacing[4],
  },
  pluginStateText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    textAlign: "center",
  },
}));
