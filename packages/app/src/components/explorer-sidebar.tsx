import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  View,
  Text,
  Pressable,
  useWindowDimensions,
  StyleSheet as RNStyleSheet,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Animated, { useAnimatedStyle, useSharedValue, runOnJS } from "react-native-reanimated";
import { scheduleOnRN } from "react-native-worklets";
import { Gesture } from "react-native-gesture-handler";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { X } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import { formatPrTabLabel, PullRequestTabIcon } from "@/git/pull-request-panel";
import { usePanelStore, selectIsFileExplorerOpen, type ExplorerTab } from "@/stores/panel-store";
import { useCloseFileExplorerGesture } from "@/mobile-panels/gestures";
import { MobilePanelOverlay } from "@/mobile-panels/presentation";
import {
  HEADER_INNER_HEIGHT,
  HEADER_INNER_HEIGHT_MOBILE,
  HEADER_TOP_PADDING_MOBILE,
} from "@/constants/layout";
import { ChangesSurface } from "@/git/diff-pane";
import { FileExplorerPane } from "./file-explorer-pane";
import { useKeyboardShiftStyle } from "@/hooks/use-keyboard-shift-style";
import { shouldUseCompactExplorerKeyboardPadding } from "@/hooks/keyboard-shift-policy";
import { useHasOwnedWindowChromeObstruction, WindowChromeSafeArea } from "@/utils/desktop-window";
import { TitlebarDragRegion } from "@/components/desktop/titlebar-drag-region";
import { RetainedPanel, RetainedPanelActivity } from "@/components/retained-panel";
import { useMountedTabSet } from "@/screens/workspace/use-mounted-tab-set";
import { SidebarResizeHandle } from "@/components/sidebar-resize-handle";
import { resolveDesktopExplorerWidth } from "@/components/desktop-sidebar-layout";
import {
  SIDEBAR_RESIZE_ACTIVATION_OFFSET,
  SIDEBAR_RESIZE_FAIL_OFFSET,
} from "@/components/sidebar-resize-handle-layout";
import { usePullRequestPanelAvailability } from "@/panels/pull-request-availability";
import { PullRequestContent } from "@/panels/pull-request";
import { useAddFileToChat } from "@/panels/use-add-file-to-chat";

function logExplorerSidebar(_event: string, _details: Record<string, unknown>): void {}

interface ExplorerSidebarProps {
  serverId: string;
  workspaceId?: string | null;
  workspaceRoot: string;
  isGit: boolean;
  onOpenFile?: (filePath: string) => void;
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
  const usePanelKeyboardPadding = shouldUseCompactExplorerKeyboardPadding({ isGit, explorerTab });
  const { style: mobileKeyboardInsetStyle } = useKeyboardShiftStyle({
    mode: "padding",
    enabled: usePanelKeyboardPadding,
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
        paddingTop: insets.top + HEADER_TOP_PADDING_MOBILE,
        paddingBottom: usePanelKeyboardPadding ? 0 : insets.bottom,
        backgroundColor: theme.colors.surfaceSidebar,
      },
      mobileKeyboardInsetStyle,
    ],
    [
      insets.bottom,
      insets.top,
      mobileKeyboardInsetStyle,
      theme.colors.surfaceSidebar,
      usePanelKeyboardPadding,
    ],
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
  const [resizePressed, setResizePressed] = useState(false);
  const showResizeGrip = useCallback(() => setResizePressed(true), []);
  const hideResizeGrip = useCallback(() => setResizePressed(false), []);

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
        .onBegin(() => {
          scheduleOnRN(showResizeGrip);
        })
        // See the left sidebar's gesture: horizontal intent only, with the start
        // width anchored to the activation translation so the threshold is free.
        .activeOffsetX([-SIDEBAR_RESIZE_ACTIVATION_OFFSET, SIDEBAR_RESIZE_ACTIVATION_OFFSET])
        .failOffsetY([-SIDEBAR_RESIZE_FAIL_OFFSET, SIDEBAR_RESIZE_FAIL_OFFSET])
        .onStart((event) => {
          startWidthRef.current = visibleExplorerWidth + event.translationX;
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
        })
        .onFinalize(() => {
          scheduleOnRN(hideResizeGrip);
        }),
    [
      hideResizeGrip,
      resizeWidth,
      setExplorerWidth,
      showResizeGrip,
      viewportWidth,
      visibleExplorerWidth,
    ],
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
          pressed={resizePressed}
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
  onTabPress: (tab: ExplorerTab) => void;
  testID: string;
  children?: React.ReactNode;
}

function ExplorerTabButton({
  tab,
  active,
  label,
  onTabPress,
  testID,
  children,
}: ExplorerTabButtonProps) {
  const handlePress = useCallback(() => onTabPress(tab), [onTabPress, tab]);
  const tabStyle = useMemo(() => [styles.tab, active && styles.tabActive], [active]);
  const tabTextStyle = useMemo(() => [styles.tabText, active && styles.tabTextActive], [active]);
  return (
    <Pressable testID={testID} style={tabStyle} onPress={handlePress}>
      {children}
      {label !== undefined ? <Text style={tabTextStyle}>{label}</Text> : null}
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
  onOpenFile?: (filePath: string) => void;
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
  const hasRightWindowControls = useHasOwnedWindowChromeObstruction("top-right");
  const { prPane, showPullRequest: showPrTab } = usePullRequestPanelAvailability({
    serverId,
    cwd: workspaceRoot,
    isGit,
    requested: activeTab === "pr",
    enabled: isOpen,
    timelineEnabled: activeTab === "pr",
  });
  const requestedTab: ExplorerTab =
    !isGit && (activeTab === "changes" || activeTab === "pr") ? "files" : activeTab;
  const resolvedTab: ExplorerTab = requestedTab === "pr" && !showPrTab ? "changes" : requestedTab;
  const prTabLabel = formatPrTabLabel(prPane.prNumber);
  const availableTabs = useMemo<ExplorerTab[]>(() => {
    const tabs: ExplorerTab[] = isGit ? ["changes", "files"] : ["files"];
    if (isGit && showPrTab) tabs.push("pr");
    return tabs;
  }, [isGit, showPrTab]);
  const { mountedTabIds } = useMountedTabSet({
    activeTabId: resolvedTab,
    allTabIds: availableTabs,
    cap: availableTabs.length,
  });

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
        {mountedTabIds.has("changes") ? (
          <RetainedPanel active={resolvedTab === "changes"}>
            <ChangedFilesPane
              serverId={serverId}
              workspaceId={workspaceId}
              workspaceRoot={workspaceRoot}
              isOpen={isOpen}
              onOpenFile={onOpenFile}
            />
          </RetainedPanel>
        ) : null}
        {mountedTabIds.has("files") ? (
          <RetainedPanel active={resolvedTab === "files"}>
            <FilesPane
              serverId={serverId}
              workspaceId={workspaceId}
              workspaceRoot={workspaceRoot}
              onOpenFile={onOpenFile}
            />
          </RetainedPanel>
        ) : null}
        {mountedTabIds.has("pr") ? (
          <RetainedPanel active={resolvedTab === "pr"}>
            <PrTabContent
              serverId={serverId}
              workspaceId={workspaceId}
              cwd={workspaceRoot}
              prPane={prPane}
            />
          </RetainedPanel>
        ) : null}
      </View>
    </View>
  );
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
  return (
    <ChangesSurface
      host="explorer"
      serverId={serverId}
      workspaceId={workspaceId}
      cwd={workspaceRoot}
      enabled={isOpen}
      onOpenFile={onOpenFile}
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
  return (
    <FileExplorerPane
      serverId={serverId}
      workspaceId={workspaceId}
      workspaceRoot={workspaceRoot}
      onOpenFile={onOpenFile}
      onAddToChat={canAddToChat ? addFile : undefined}
    />
  );
}

const PrTabContent = PullRequestContent;

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
    height: {
      xs: HEADER_INNER_HEIGHT_MOBILE,
      md: HEADER_INNER_HEIGHT,
    },
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
  },
  tabsContainer: {
    flexDirection: "row",
    gap: theme.spacing[1],
  },
  tab: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingVertical: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    borderRadius: theme.borderRadius.md,
  },
  tabActive: {
    backgroundColor: theme.colors.surfaceSidebarHover,
  },
  tabText: {
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.normal,
    color: theme.colors.foregroundMuted,
  },
  tabTextActive: {
    color: theme.colors.foreground,
  },
  tabTextMuted: {
    opacity: 0.8,
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
}));
