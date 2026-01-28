import { useCallback, useMemo, useRef } from "react";
import { View, Text, Pressable, Platform } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  runOnJS,
} from "react-native-reanimated";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import { StyleSheet, UnistylesRuntime, useUnistyles } from "react-native-unistyles";
import { X, LayoutGrid, List as ListIcon } from "lucide-react-native";
import {
  usePanelStore,
  MIN_EXPLORER_SIDEBAR_WIDTH,
  MAX_EXPLORER_SIDEBAR_WIDTH,
  type ViewMode,
  type ExplorerTab,
} from "@/stores/panel-store";
import { useExplorerSidebarAnimation } from "@/contexts/explorer-sidebar-animation-context";
import { HEADER_INNER_HEIGHT } from "@/constants/layout";
import { useCheckoutStatusQuery } from "@/hooks/use-checkout-status-query";
import { GitDiffPane } from "./git-diff-pane";
import { FileExplorerPane } from "./file-explorer-pane";

interface ExplorerSidebarProps {
  serverId: string;
  agentId: string;
  cwd: string;
}

export function ExplorerSidebar({ serverId, agentId, cwd }: ExplorerSidebarProps) {
  const { theme } = useUnistyles();
  const insets = useSafeAreaInsets();
  const isMobile =
    UnistylesRuntime.breakpoint === "xs" || UnistylesRuntime.breakpoint === "sm";
  const mobileView = usePanelStore((state) => state.mobileView);
  const desktopFileExplorerOpen = usePanelStore((state) => state.desktop.fileExplorerOpen);
  const closeToAgent = usePanelStore((state) => state.closeToAgent);
  const explorerTab = usePanelStore((state) => state.explorerTab);
  const explorerWidth = usePanelStore((state) => state.explorerWidth);
  const explorerViewMode = usePanelStore((state) => state.explorerViewMode);
  const setExplorerTab = usePanelStore((state) => state.setExplorerTab);
  const setExplorerWidth = usePanelStore((state) => state.setExplorerWidth);
  const setExplorerViewMode = usePanelStore((state) => state.setExplorerViewMode);

  // Derive isOpen from the unified panel state
  const isOpen = isMobile ? mobileView === "file-explorer" : desktopFileExplorerOpen;

  const {
    translateX,
    backdropOpacity,
    windowWidth,
    animateToOpen,
    animateToClose,
    isGesturing,
    closeGestureRef,
  } = useExplorerSidebarAnimation();

  // For resize drag, track the starting width
  const startWidthRef = useRef(explorerWidth);
  const resizeWidth = useSharedValue(explorerWidth);

  const handleClose = useCallback(() => {
    closeToAgent();
  }, [closeToAgent]);

  const handleTabPress = useCallback(
    (tab: ExplorerTab) => {
      setExplorerTab(tab);
    },
    [setExplorerTab]
  );

  // Swipe gesture to close (swipe right on mobile)
  const closeGesture = useMemo(
    () =>
      Gesture.Pan()
        .withRef(closeGestureRef)
        .enabled(isMobile && isOpen)
        // Only activate on rightward swipe (positive X), fail on leftward or vertical
        // This allows ScrollViews using waitFor to scroll left normally
        .activeOffsetX(15)
        .failOffsetX(-10)
        .failOffsetY([-10, 10])
        .onStart(() => {
          isGesturing.value = true;
        })
        .onUpdate((event) => {
          // Right sidebar: swipe right to close (positive translationX)
          const newTranslateX = Math.max(0, Math.min(windowWidth, event.translationX));
          translateX.value = newTranslateX;
          const progress = 1 - newTranslateX / windowWidth;
          backdropOpacity.value = Math.max(0, Math.min(1, progress));
        })
        .onEnd((event) => {
          isGesturing.value = false;
          const shouldClose =
            event.translationX > windowWidth / 3 || event.velocityX > 500;
          if (shouldClose) {
            animateToClose();
            runOnJS(handleClose)();
          } else {
            animateToOpen();
          }
        })
        .onFinalize(() => {
          isGesturing.value = false;
        }),
    [
      isMobile,
      isOpen,
      windowWidth,
      translateX,
      backdropOpacity,
      animateToOpen,
      animateToClose,
      handleClose,
      isGesturing,
      closeGestureRef,
    ]
  );

  // Desktop resize gesture (drag left edge)
  const resizeGesture = useMemo(
    () =>
      Gesture.Pan()
        .enabled(!isMobile)
        .hitSlop({ left: 8, right: 8, top: 0, bottom: 0 })
        .onStart(() => {
          startWidthRef.current = explorerWidth;
          resizeWidth.value = explorerWidth;
        })
        .onUpdate((event) => {
          // Dragging left (negative translationX) increases width
          const newWidth = startWidthRef.current - event.translationX;
          const clampedWidth = Math.max(
            MIN_EXPLORER_SIDEBAR_WIDTH,
            Math.min(MAX_EXPLORER_SIDEBAR_WIDTH, newWidth)
          );
          resizeWidth.value = clampedWidth;
        })
        .onEnd(() => {
          runOnJS(setExplorerWidth)(resizeWidth.value);
        }),
    [isMobile, explorerWidth, resizeWidth, setExplorerWidth]
  );

  const sidebarAnimatedStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: translateX.value }],
  }));

  const backdropAnimatedStyle = useAnimatedStyle(() => ({
    opacity: backdropOpacity.value,
    pointerEvents: backdropOpacity.value > 0.01 ? "auto" : "none",
  }));

  const resizeAnimatedStyle = useAnimatedStyle(() => ({
    width: resizeWidth.value,
  }));

  // Mobile: full-screen overlay with gesture
  const overlayPointerEvents = Platform.OS === "web" ? "auto" : "box-none";

  if (isMobile) {
    return (
      <View style={StyleSheet.absoluteFillObject} pointerEvents={overlayPointerEvents}>
        {/* Backdrop */}
        <Animated.View style={[styles.backdrop, backdropAnimatedStyle]}>
          <Pressable style={styles.backdropPressable} onPress={handleClose} />
        </Animated.View>

        <GestureDetector gesture={closeGesture} touchAction="pan-y">
          <Animated.View
            style={[
              styles.mobileSidebar,
              { width: windowWidth, paddingTop: insets.top, paddingBottom: insets.bottom },
              sidebarAnimatedStyle,
            ]}
            pointerEvents="auto"
          >
            <SidebarContent
              activeTab={explorerTab}
              onTabPress={handleTabPress}
              onClose={handleClose}
              serverId={serverId}
              agentId={agentId}
              cwd={cwd}
              fileViewMode={explorerViewMode}
              onFileViewModeChange={setExplorerViewMode}
              isMobile={isMobile}
            />
          </Animated.View>
        </GestureDetector>
      </View>
    );
  }

  // Desktop: fixed width sidebar with resize handle
  if (!isOpen) {
    return null;
  }

  return (
    <Animated.View style={[styles.desktopSidebar, resizeAnimatedStyle]}>
      {/* Resize handle - absolutely positioned over left border */}
      <GestureDetector gesture={resizeGesture}>
        <View
          style={[
            styles.resizeHandle,
            Platform.OS === "web" && ({ cursor: "col-resize" } as any),
          ]}
        />
      </GestureDetector>

      <SidebarContent
        activeTab={explorerTab}
        onTabPress={handleTabPress}
        onClose={handleClose}
        serverId={serverId}
        agentId={agentId}
        cwd={cwd}
        fileViewMode={explorerViewMode}
        onFileViewModeChange={setExplorerViewMode}
        isMobile={false}
      />
    </Animated.View>
  );
}

interface SidebarContentProps {
  activeTab: ExplorerTab;
  onTabPress: (tab: ExplorerTab) => void;
  onClose: () => void;
  serverId: string;
  agentId: string;
  cwd: string;
  fileViewMode: ViewMode;
  onFileViewModeChange: (mode: ViewMode) => void;
  isMobile: boolean;
}

function SidebarContent({
  activeTab,
  onTabPress,
  onClose,
  serverId,
  agentId,
  cwd,
  fileViewMode,
  onFileViewModeChange,
  isMobile,
}: SidebarContentProps) {
  const { theme } = useUnistyles();
  const { status } = useCheckoutStatusQuery({ serverId, cwd });
  const isGit = status?.isGit ?? false;

  // If not a git repo, only show files tab
  const effectiveTab = isGit ? activeTab : "files";

  return (
    <View style={styles.sidebarContent} pointerEvents="auto">
      {/* Header with tabs and close button */}
      <View style={styles.header} testID="explorer-header">
        <View style={styles.tabsContainer}>
          {isGit ? (
            <Pressable
              style={[styles.tab, effectiveTab === "changes" && styles.tabActive]}
              onPress={() => onTabPress("changes")}
            >
              <Text
                style={[
                  styles.tabText,
                  effectiveTab === "changes" && styles.tabTextActive,
                ]}
              >
                Changes
              </Text>
            </Pressable>
          ) : null}
          <Pressable
            style={[styles.tab, effectiveTab === "files" && styles.tabActive]}
            onPress={() => onTabPress("files")}
          >
            <Text
              style={[
                styles.tabText,
                effectiveTab === "files" && styles.tabTextActive,
              ]}
            >
              Files
            </Text>
          </Pressable>
        </View>
        <View style={styles.headerRightSection}>
          {effectiveTab === "files" && (
            <ViewToggle viewMode={fileViewMode} onChange={onFileViewModeChange} />
          )}
          {isMobile && (
            <Pressable onPress={onClose} style={styles.closeButton}>
              <X size={18} color={theme.colors.foregroundMuted} />
            </Pressable>
          )}
        </View>
      </View>

      {/* Content based on active tab */}
      <View style={styles.contentArea} testID="explorer-content-area">
        {effectiveTab === "changes" && (
          <GitDiffPane serverId={serverId} agentId={agentId} cwd={cwd} />
        )}
        {effectiveTab === "files" && (
          <FileExplorerPane serverId={serverId} agentId={agentId} />
        )}
      </View>
    </View>
  );
}

function ViewToggle({
  viewMode,
  onChange,
}: {
  viewMode: ViewMode;
  onChange: (mode: ViewMode) => void;
}) {
  const { theme } = useUnistyles();

  return (
    <View style={styles.viewToggleContainer}>
      <Pressable
        style={[styles.viewToggleButton, viewMode === "list" && styles.viewToggleActive]}
        onPress={() => onChange("list")}
      >
        <ListIcon size={14} color={theme.colors.foreground} />
      </Pressable>
      <Pressable
        style={[styles.viewToggleButton, viewMode === "grid" && styles.viewToggleActive]}
        onPress={() => onChange("grid")}
      >
        <LayoutGrid size={14} color={theme.colors.foreground} />
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  backdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "rgba(0, 0, 0, 0.5)",
  },
  backdropPressable: {
    flex: 1,
  },
  mobileSidebar: {
    position: "absolute",
    top: 0,
    right: 0,
    bottom: 0,
    backgroundColor: theme.colors.surface0,
    overflow: "hidden",
  },
  desktopSidebar: {
    position: "relative",
    borderLeftWidth: 1,
    borderLeftColor: theme.colors.border,
    backgroundColor: theme.colors.surface0,
  },
  resizeHandle: {
    position: "absolute",
    left: -5,
    top: 0,
    bottom: 0,
    width: 10,
    zIndex: 10,
  },
  sidebarContent: {
    flex: 1,
    minHeight: 0,
    overflow: "hidden",
  },
  header: {
    height: HEADER_INNER_HEIGHT,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: theme.spacing[2],
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
    backgroundColor: theme.colors.surface2,
  },
  tabText: {
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.normal,
    color: theme.colors.foregroundMuted,
  },
  tabTextActive: {
    color: theme.colors.foreground,
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
  viewToggleContainer: {
    flexDirection: "row",
    borderRadius: theme.borderRadius.md,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    overflow: "hidden",
  },
  viewToggleButton: {
    padding: theme.spacing[2],
  },
  viewToggleActive: {
    backgroundColor: theme.colors.surface2,
  },
}));
