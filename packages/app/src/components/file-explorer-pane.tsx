import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  Image as RNImage,
  LayoutChangeEvent,
  ListRenderItemInfo,
  Modal,
  Pressable,
  ScrollView as RNScrollView,
  Text,
  View,
  Platform,
  useWindowDimensions,
} from "react-native";
import { ScrollView, Gesture, GestureDetector } from "react-native-gesture-handler";
import { StyleSheet, UnistylesRuntime, useUnistyles } from "react-native-unistyles";
import Animated, {
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
} from "react-native-reanimated";
import { Fonts } from "@/constants/theme";
import * as Clipboard from "expo-clipboard";
import {
  BottomSheetModal,
  BottomSheetScrollView,
  BottomSheetBackdrop,
} from "@gorhom/bottom-sheet";
import {
  File,
  FileText,
  Folder,
  FolderOpen,
  Image as ImageIcon,
  MoreVertical,
  X,
} from "lucide-react-native";
import type { ExplorerEntry, ExplorerFile } from "@/stores/session-store";
import { useDaemonConnections } from "@/contexts/daemon-connections-context";
import { useSessionStore } from "@/stores/session-store";
import { useDownloadStore } from "@/stores/download-store";
import { useFileExplorerActions } from "@/hooks/use-file-explorer-actions";
import {
  usePanelStore,
  DEFAULT_EXPLORER_FILES_SPLIT_RATIO,
  type SortOption,
} from "@/stores/panel-store";
import { formatTimeAgo } from "@/utils/time";

const SORT_OPTIONS: { value: SortOption; label: string }[] = [
  { value: "name", label: "Name" },
  { value: "modified", label: "Modified" },
  { value: "size", label: "Size" },
];

const INDENT_PER_LEVEL = 12;

interface FileExplorerPaneProps {
  serverId: string;
  agentId: string;
}

interface TreeRow {
  entry: ExplorerEntry;
  depth: number;
}

export function FileExplorerPane({ serverId, agentId }: FileExplorerPaneProps) {
  const { theme } = useUnistyles();
  const isMobile =
    UnistylesRuntime.breakpoint === "xs" || UnistylesRuntime.breakpoint === "sm";
  const { width: windowWidth, height: windowHeight } = useWindowDimensions();

  const { connectionStates } = useDaemonConnections();
  const daemonProfile = connectionStates.get(serverId)?.daemon;
  const agentExists = useSessionStore((state) =>
    agentId && state.sessions[serverId]
      ? state.sessions[serverId]?.agents.has(agentId)
      : false
  );
  const explorerState = useSessionStore((state) =>
    agentId && state.sessions[serverId]
      ? state.sessions[serverId]?.fileExplorer.get(agentId)
      : undefined
  );

  const {
    requestDirectoryListing,
    requestFilePreview,
    requestFileDownloadToken,
    selectExplorerEntry,
  } = useFileExplorerActions(serverId);
  const sortOption = usePanelStore((state) => state.explorerSortOption);
  const setSortOption = usePanelStore((state) => state.setExplorerSortOption);
  const splitRatio = usePanelStore((state) => state.explorerFilesSplitRatio);
  const setSplitRatio = usePanelStore((state) => state.setExplorerFilesSplitRatio);

  const directories = explorerState?.directories ?? new Map();
  const files = explorerState?.files ?? new Map();
  const pendingRequest = explorerState?.pendingRequest ?? null;
  const isExplorerLoading = explorerState?.isLoading ?? false;
  const error = explorerState?.lastError ?? null;
  const selectedEntryPath = explorerState?.selectedEntryPath ?? null;
  const selectedEntryLineStart = explorerState?.selectedEntryLineStart ?? null;

  const preview = selectedEntryPath ? files.get(selectedEntryPath) : null;
  const isPreviewLoading = Boolean(
    isExplorerLoading &&
      pendingRequest?.mode === "file" &&
      pendingRequest?.path === selectedEntryPath
  );

  const isDirectoryLoading = useCallback(
    (path: string) =>
      Boolean(
        isExplorerLoading && pendingRequest?.mode === "list" && pendingRequest?.path === path
      ),
    [isExplorerLoading, pendingRequest?.mode, pendingRequest?.path]
  );

  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(() => new Set(["."]));
  const [menuEntry, setMenuEntry] = useState<ExplorerEntry | null>(null);
  const [menuAnchor, setMenuAnchor] = useState({ top: 0, left: 0 });
  const [menuHeight, setMenuHeight] = useState(0);
  const [containerWidth, setContainerWidth] = useState(0);

  // Bottom sheet for file preview (mobile)
  const previewSheetRef = useRef<BottomSheetModal>(null);
  const previewSnapPoints = useMemo(() => ["70%", "95%"], []);

  const hasInitializedRef = useRef(false);
  useEffect(() => {
    if (!agentId || !requestDirectoryListing) {
      return;
    }
    if (hasInitializedRef.current) {
      return;
    }
    hasInitializedRef.current = true;
    requestDirectoryListing(agentId, ".", { recordHistory: false, setCurrentPath: false });
  }, [agentId, requestDirectoryListing]);

  // Expand ancestor directories when a file is selected (e.g., from an inline path click)
  useEffect(() => {
    if (!agentId || !selectedEntryPath || !requestDirectoryListing) {
      return;
    }
    const parentDir = getParentDirectory(selectedEntryPath);
    const ancestors = getAncestorDirectories(parentDir);

    setExpandedPaths((prev) => {
      const next = new Set(prev);
      ancestors.forEach((path) => next.add(path));
      return next;
    });

    ancestors.forEach((path) => {
      if (!directories.has(path)) {
        requestDirectoryListing(agentId, path, { recordHistory: false, setCurrentPath: false });
      }
    });
  }, [agentId, directories, requestDirectoryListing, selectedEntryPath]);

  // Open/close preview sheet based on selection
  useEffect(() => {
    if (!isMobile) {
      return;
    }
    if (selectedEntryPath) {
      previewSheetRef.current?.present();
    } else {
      previewSheetRef.current?.dismiss();
    }
  }, [isMobile, selectedEntryPath]);

  const handleClosePreview = useCallback(() => {
    if (!agentId) {
      return;
    }
    selectExplorerEntry(agentId, null);
  }, [agentId, selectExplorerEntry]);

  const handleToggleDirectory = useCallback(
    (entry: ExplorerEntry) => {
      if (!agentId || !requestDirectoryListing) {
        return;
      }

      const isExpanded = expandedPaths.has(entry.path);
      const nextExpanded = !isExpanded;
      setExpandedPaths((prev) => {
        const next = new Set(prev);
        if (isExpanded) {
          next.delete(entry.path);
        } else {
          next.add(entry.path);
        }
        return next;
      });

      if (nextExpanded && !directories.has(entry.path)) {
        requestDirectoryListing(agentId, entry.path, { recordHistory: false, setCurrentPath: false });
      }
    },
    [agentId, directories, expandedPaths, requestDirectoryListing]
  );

  const handleOpenFile = useCallback(
    (entry: ExplorerEntry) => {
      if (!agentId || !requestFilePreview) {
        return;
      }
      selectExplorerEntry(agentId, entry.path);
      requestFilePreview(agentId, entry.path);
    },
    [agentId, requestFilePreview, selectExplorerEntry]
  );

  const handleEntryPress = useCallback(
    (entry: ExplorerEntry) => {
      if (entry.kind === "directory") {
        handleToggleDirectory(entry);
        return;
      }
      handleOpenFile(entry);
    },
    [handleOpenFile, handleToggleDirectory]
  );

  const handleCopyPath = useCallback(async (path: string) => {
    await Clipboard.setStringAsync(path);
  }, []);

  const handleOpenMenu = useCallback((entry: ExplorerEntry, event: any) => {
    event.stopPropagation();
    const { pageX, pageY } = event.nativeEvent ?? {};
    setMenuAnchor({
      left: typeof pageX === "number" ? pageX : 0,
      top: typeof pageY === "number" ? pageY : 0,
    });
    setMenuEntry(entry);
  }, []);

  const handleCloseMenu = useCallback(() => {
    setMenuEntry(null);
    setMenuHeight(0);
  }, []);

  const handleMenuLayout = useCallback((event: LayoutChangeEvent) => {
    const { height } = event.nativeEvent.layout;
    setMenuHeight((current) => (current === height ? current : height));
  }, []);

  const startDownload = useDownloadStore((state) => state.startDownload);
  const handleDownloadEntry = useCallback(
    (entry: ExplorerEntry) => {
      if (!agentId || !requestFileDownloadToken || entry.kind !== "file") {
        return;
      }

      startDownload({
        serverId,
        agentId,
        fileName: entry.name,
        path: entry.path,
        daemonProfile,
        requestFileDownloadToken,
      });
    },
    [agentId, serverId, daemonProfile, requestFileDownloadToken, startDownload]
  );

  const menuPosition = useMemo(() => {
    if (!menuEntry) {
      return null;
    }
    const menuWidth = 240;
    const horizontalPadding = theme.spacing[2];
    const verticalPadding = theme.spacing[2];
    const maxLeft = Math.max(horizontalPadding, windowWidth - menuWidth - horizontalPadding);
    const maxTop = Math.max(verticalPadding, windowHeight - menuHeight - verticalPadding);
    const left = Math.min(
      Math.max(menuAnchor.left - menuWidth + horizontalPadding, horizontalPadding),
      maxLeft
    );
    const top = Math.min(Math.max(menuAnchor.top + verticalPadding, verticalPadding), maxTop);
    return { top, left, width: menuWidth };
  }, [menuAnchor.left, menuAnchor.top, menuEntry, menuHeight, theme.spacing, windowHeight, windowWidth]);

  const handleSortCycle = useCallback(() => {
    const currentIndex = SORT_OPTIONS.findIndex((opt) => opt.value === sortOption);
    const nextIndex = (currentIndex + 1) % SORT_OPTIONS.length;
    setSortOption(SORT_OPTIONS[nextIndex].value);
  }, [sortOption, setSortOption]);

  const currentSortLabel = SORT_OPTIONS.find((opt) => opt.value === sortOption)?.label ?? "Name";

  const treeRows = useMemo(() => {
    const rootDirectory = directories.get(".");
    if (!rootDirectory) {
      return [];
    }
    return buildTreeRows({
      directories,
      expandedPaths,
      sortOption,
      path: ".",
      depth: 0,
    });
  }, [directories, expandedPaths, sortOption]);

  const showInitialLoading =
    !directories.has(".") &&
    Boolean(isExplorerLoading && pendingRequest?.mode === "list" && pendingRequest?.path === ".");

  const shouldShowInlinePreview = !isMobile && Boolean(selectedEntryPath);
  const minTreeWidth = 220;
  const minPreviewWidth = 320;

  const safeSplitRatio = Number.isFinite(splitRatio)
    ? splitRatio
    : DEFAULT_EXPLORER_FILES_SPLIT_RATIO;

  const splitAvailableWidth = useSharedValue(0);
  const splitMaxTreeWidth = useSharedValue(minTreeWidth);
  const splitTreeWidth = useSharedValue(minTreeWidth);
  const splitStartTreeWidth = useSharedValue(minTreeWidth);

  useEffect(() => {
    if (!shouldShowInlinePreview) {
      return;
    }
    if (containerWidth <= 0) {
      return;
    }

    const available = Math.max(0, containerWidth);
    const maxTree = Math.max(minTreeWidth, available - minPreviewWidth);
    const desired = Math.round(available * safeSplitRatio);
    const clamped = Math.max(minTreeWidth, Math.min(maxTree, desired));

    splitAvailableWidth.value = available;
    splitMaxTreeWidth.value = maxTree;
    splitTreeWidth.value = clamped;
  }, [
    containerWidth,
    minPreviewWidth,
    minTreeWidth,
    safeSplitRatio,
    shouldShowInlinePreview,
    splitAvailableWidth,
    splitMaxTreeWidth,
    splitTreeWidth,
  ]);

  const treePaneAnimatedStyle = useAnimatedStyle(() => ({
    width: splitTreeWidth.value,
    flexBasis: splitTreeWidth.value,
    flexGrow: 0,
    flexShrink: 0,
  }));

  const splitResizeGesture = useMemo(() => {
    if (isMobile || !shouldShowInlinePreview) {
      return Gesture.Pan().enabled(false);
    }

    return Gesture.Pan()
      .hitSlop({ left: 12, right: 12, top: 0, bottom: 0 })
      .onStart(() => {
        splitStartTreeWidth.value = splitTreeWidth.value;
      })
      .onUpdate((event) => {
        const nextWidth = splitStartTreeWidth.value + event.translationX;
        const clamped = Math.max(
          minTreeWidth,
          Math.min(splitMaxTreeWidth.value, nextWidth)
        );
        splitTreeWidth.value = clamped;
      })
      .onEnd(() => {
        const available = splitAvailableWidth.value;
        const ratio = available > 0 ? splitTreeWidth.value / available : safeSplitRatio;
        runOnJS(setSplitRatio)(ratio);
      });
  }, [
    isMobile,
    minTreeWidth,
    safeSplitRatio,
    setSplitRatio,
    shouldShowInlinePreview,
    splitAvailableWidth,
    splitMaxTreeWidth,
    splitStartTreeWidth,
    splitTreeWidth,
  ]);

  const renderTreeRow = useCallback(
    ({ item }: ListRenderItemInfo<TreeRow>) => {
      const entry = item.entry;
      const depth = item.depth;
      const displayKind = getEntryDisplayKind(entry);
      const isDirectory = entry.kind === "directory";
      const isExpanded = isDirectory && expandedPaths.has(entry.path);
      const isSelected = selectedEntryPath === entry.path;
      const loading = isDirectory && isDirectoryLoading(entry.path);

      return (
        <Pressable
          onPress={() => handleEntryPress(entry)}
          style={({ hovered, pressed }) => [
            styles.entryRow,
            { paddingLeft: theme.spacing[2] + depth * INDENT_PER_LEVEL },
            (hovered || pressed || isSelected) && styles.entryRowActive,
          ]}
        >
          <View style={styles.entryInfo}>
            <View style={styles.entryIcon}>
              {loading ? (
                <ActivityIndicator size="small" />
              ) : (
                renderEntryIcon(isDirectory ? "directory" : displayKind, {
                  foreground: theme.colors.foregroundMuted,
                  primary: theme.colors.primary,
                  directoryOpen: isExpanded,
                })
              )}
            </View>
            <Text style={styles.entryName} numberOfLines={1}>
              {entry.name}
            </Text>
          </View>
          <Pressable
            onPress={(event) => handleOpenMenu(entry, event)}
            hitSlop={8}
            style={({ hovered, pressed }) => [
              styles.menuButton,
              (hovered || pressed) && styles.menuButtonActive,
            ]}
          >
            <MoreVertical size={16} color={theme.colors.foregroundMuted} />
          </Pressable>
        </Pressable>
      );
    },
    [
      expandedPaths,
      handleEntryPress,
      handleOpenMenu,
      isDirectoryLoading,
      selectedEntryPath,
      theme.colors,
      theme.spacing,
    ]
  );

  const handlePreviewSheetChange = useCallback(
    (index: number) => {
      if (index === -1) {
        handleClosePreview();
      }
    },
    [handleClosePreview]
  );

  const renderPreviewBackdrop = useCallback(
    (props: React.ComponentProps<typeof BottomSheetBackdrop>) => (
      <BottomSheetBackdrop
        {...props}
        disappearsOnIndex={-1}
        appearsOnIndex={0}
        opacity={0.5}
      />
    ),
    []
  );

  if (!agentExists) {
    return (
      <View style={styles.centerState}>
        <Text style={styles.errorText}>Agent not found</Text>
      </View>
    );
  }

  return (
    <View
      style={styles.container}
      onLayout={(event) => setContainerWidth(event.nativeEvent.layout.width)}
    >
      {error ? (
        <View style={styles.centerState}>
          <Text style={styles.errorText}>{error}</Text>
          <Pressable
            style={styles.retryButton}
            onPress={() => {
              if (agentId) {
                requestDirectoryListing(agentId, ".", {
                  recordHistory: false,
                  setCurrentPath: false,
                });
              }
            }}
          >
            <Text style={styles.retryButtonText}>Retry</Text>
          </Pressable>
        </View>
      ) : showInitialLoading ? (
        <View style={styles.centerState}>
          <ActivityIndicator size="small" />
          <Text style={styles.loadingText}>Loading files…</Text>
        </View>
      ) : treeRows.length === 0 ? (
        <View style={styles.centerState}>
          <Text style={styles.emptyText}>No files</Text>
        </View>
      ) : (
        <View style={styles.desktopSplit}>
          <Animated.View
            style={[
              styles.treePane,
              shouldShowInlinePreview
                ? [styles.treePaneWithPreview, { minWidth: minTreeWidth }, treePaneAnimatedStyle]
                : styles.treePaneFill,
            ]}
          >
            <View style={styles.paneHeader} testID="files-pane-header">
              <View style={styles.paneHeaderLeft} />
              <Pressable style={styles.sortButton} onPress={handleSortCycle}>
                <Text style={styles.sortButtonText}>{currentSortLabel}</Text>
              </Pressable>
            </View>
            <FlatList
              style={styles.treeList}
              data={treeRows}
              renderItem={renderTreeRow}
              keyExtractor={(row) => row.entry.path}
              contentContainerStyle={styles.entriesContent}
              initialNumToRender={24}
              maxToRenderPerBatch={40}
              windowSize={12}
            />
          </Animated.View>

          {shouldShowInlinePreview ? (
            <View style={styles.previewPane}>
              <GestureDetector gesture={splitResizeGesture}>
                <View
                  style={[
                    styles.splitResizeHandle,
                    Platform.OS === "web" && ({ cursor: "col-resize" } as any),
                    Platform.OS === "web" && ({ touchAction: "none", userSelect: "none" } as any),
                  ]}
                />
              </GestureDetector>
              <View style={styles.paneHeader} testID="preview-pane-header">
                <Text style={styles.previewHeaderText} numberOfLines={1}>
                  {selectedEntryPath?.split("/").pop() ?? "Preview"}
                </Text>
                <View style={styles.previewHeaderRight}>
                  {isPreviewLoading ? (
                    <ActivityIndicator size="small" color={theme.colors.foregroundMuted} />
                  ) : null}
                  <Pressable
                    onPress={handleClosePreview}
                    hitSlop={8}
                    style={({ hovered, pressed }) => [
                      styles.iconButton,
                      (hovered || pressed) && styles.iconButtonHovered,
                    ]}
                    accessibilityRole="button"
                    accessibilityLabel="Close preview"
                  >
                    <X size={16} color={theme.colors.foregroundMuted} />
                  </Pressable>
                </View>
              </View>

              <FilePreviewBody
                preview={preview}
                isLoading={isPreviewLoading}
                lineStart={selectedEntryLineStart}
                variant="inline"
              />
            </View>
          ) : null}
        </View>
      )}

      <Modal
        visible={Boolean(menuEntry)}
        animationType="fade"
        transparent={true}
        onRequestClose={handleCloseMenu}
      >
        <View style={styles.menuOverlay}>
          <Pressable style={styles.menuBackdrop} onPress={handleCloseMenu} />
          {menuEntry && menuPosition ? (
            <View
              style={[
                styles.entryMenu,
                {
                  position: "absolute",
                  top: menuPosition.top,
                  left: menuPosition.left,
                  width: menuPosition.width,
                },
              ]}
              onLayout={handleMenuLayout}
            >
              <View style={styles.entryMenuHeader}>
                <Text style={styles.entryMenuMeta}>
                  {formatFileSize({ size: menuEntry.size })}
                </Text>
                <Text style={styles.entryMenuMeta}>
                  {formatTimeAgo(new Date(menuEntry.modifiedAt))}
                </Text>
              </View>
              <View style={styles.entryMenuDivider} />
              <Pressable
                style={({ hovered, pressed }) => [
                  styles.entryMenuItem,
                  (hovered || pressed) && styles.entryMenuItemHovered,
                ]}
                onPress={() => {
                  handleCopyPath(menuEntry.path);
                  handleCloseMenu();
                }}
              >
                <Text style={styles.entryMenuText}>Copy path</Text>
              </Pressable>
              {menuEntry.kind === "file" ? (
                <Pressable
                  style={({ hovered, pressed }) => [
                    styles.entryMenuItem,
                    (hovered || pressed) && styles.entryMenuItemHovered,
                  ]}
                  onPress={async () => {
                    handleCloseMenu();
                    handleDownloadEntry(menuEntry);
                  }}
                >
                  <Text style={styles.entryMenuText}>Download</Text>
                </Pressable>
              ) : null}
            </View>
          ) : null}
        </View>
      </Modal>

      {isMobile ? (
        <BottomSheetModal
          ref={previewSheetRef}
          snapPoints={previewSnapPoints}
          index={0}
          enableDynamicSizing={false}
          onChange={handlePreviewSheetChange}
          backdropComponent={renderPreviewBackdrop}
          enablePanDownToClose
          backgroundStyle={styles.sheetBackground}
          handleIndicatorStyle={styles.handleIndicator}
        >
          <View style={styles.sheetHeader}>
            <Text style={styles.sheetTitle} numberOfLines={1}>
              {selectedEntryPath?.split("/").pop() ?? "Preview"}
            </Text>
            <Pressable onPress={handleClosePreview} style={styles.sheetCloseButton}>
              <X size={20} color={theme.colors.foregroundMuted} />
            </Pressable>
          </View>
          <FilePreviewBody
            preview={preview}
            isLoading={isPreviewLoading}
            lineStart={selectedEntryLineStart}
            variant="sheet"
          />
        </BottomSheetModal>
      ) : null}
    </View>
  );
}

function FilePreviewBody({
  preview,
  isLoading,
  lineStart,
  variant,
}: {
  preview: ExplorerFile | null;
  isLoading: boolean;
  lineStart: number | null;
  variant: "inline" | "sheet";
}) {
  const CODE_LINE_HEIGHT = 20;
  const scrollRef = useRef<any>(null);

  useEffect(() => {
    if (!preview || preview.kind !== "text") {
      return;
    }
    if (!lineStart || lineStart <= 1) {
      return;
    }
    const y = Math.max(0, (lineStart - 1) * CODE_LINE_HEIGHT);
    requestAnimationFrame(() => {
      scrollRef.current?.scrollTo?.({ y, animated: true });
    });
  }, [lineStart, preview?.kind, preview?.path]);

  if (isLoading && !preview) {
    return (
      <View style={styles.sheetCenterState}>
        <ActivityIndicator size="small" />
        <Text style={styles.loadingText}>Loading file…</Text>
      </View>
    );
  }

  if (!preview) {
    return (
      <View style={styles.sheetCenterState}>
        <Text style={styles.emptyText}>No preview available</Text>
      </View>
    );
  }

  if (preview.kind === "text") {
    if (variant === "sheet") {
      return (
        <BottomSheetScrollView ref={scrollRef} style={styles.previewContent}>
          <ScrollView
            horizontal
            nestedScrollEnabled
            showsHorizontalScrollIndicator
            contentContainerStyle={styles.previewCodeScrollContent}
          >
            <Text style={styles.codeText}>{preview.content}</Text>
          </ScrollView>
        </BottomSheetScrollView>
      );
    }
    return (
      <RNScrollView ref={scrollRef} style={styles.previewContent}>
        <RNScrollView
          horizontal
          nestedScrollEnabled
          showsHorizontalScrollIndicator
          contentContainerStyle={styles.previewCodeScrollContent}
        >
          <Text style={styles.codeText}>{preview.content}</Text>
        </RNScrollView>
      </RNScrollView>
    );
  }

  if (preview.kind === "image" && preview.content) {
    if (variant === "sheet") {
      return (
        <BottomSheetScrollView contentContainerStyle={styles.previewImageScrollContent}>
          <RNImage
            source={{
              uri: `data:${preview.mimeType ?? "image/png"};base64,${preview.content}`,
            }}
            style={styles.previewImage}
            resizeMode="contain"
          />
        </BottomSheetScrollView>
      );
    }
    return (
      <RNScrollView contentContainerStyle={styles.previewImageScrollContent}>
        <RNImage
          source={{
            uri: `data:${preview.mimeType ?? "image/png"};base64,${preview.content}`,
          }}
          style={styles.previewImage}
          resizeMode="contain"
        />
      </RNScrollView>
    );
  }

  return (
    <View style={styles.sheetCenterState}>
      <Text style={styles.emptyText}>Binary preview unavailable</Text>
      <Text style={styles.entryMenuMeta}>{formatFileSize({ size: preview.size })}</Text>
    </View>
  );
}

function formatFileSize({ size }: { size: number }): string {
  if (size < 1024) {
    return `${size} B`;
  }
  if (size < 1024 * 1024) {
    return `${(size / 1024).toFixed(1)} KB`;
  }
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

type EntryDisplayKind = "directory" | "image" | "text" | "other";

const IMAGE_EXTENSIONS = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "bmp",
  "svg",
  "webp",
  "ico",
]);

const TEXT_EXTENSIONS = new Set([
  "txt",
  "md",
  "markdown",
  "ts",
  "tsx",
  "js",
  "jsx",
  "json",
  "yml",
  "yaml",
  "toml",
  "py",
  "rb",
  "go",
  "rs",
  "java",
  "kt",
  "c",
  "cpp",
  "cc",
  "h",
  "hpp",
  "cs",
  "swift",
  "php",
  "html",
  "css",
  "scss",
  "less",
  "xml",
  "sh",
  "bash",
  "zsh",
  "ini",
  "cfg",
  "conf",
]);

function renderEntryIcon(
  kind: EntryDisplayKind,
  colors: { foreground: string; primary: string; directoryOpen?: boolean }
) {
  const color = colors.foreground;
  switch (kind) {
    case "directory":
      return colors.directoryOpen ? (
        <FolderOpen size={18} color={colors.primary} />
      ) : (
        <Folder size={18} color={colors.primary} />
      );
    case "image":
      return <ImageIcon size={18} color={color} />;
    case "text":
      return <FileText size={18} color={color} />;
    default:
      return <File size={18} color={color} />;
  }
}

function getEntryDisplayKind(entry: ExplorerEntry): EntryDisplayKind {
  if (entry.kind === "directory") {
    return "directory";
  }

  const extension = getExtension(entry.name);
  if (extension === null) {
    return "other";
  }

  if (IMAGE_EXTENSIONS.has(extension)) {
    return "image";
  }

  if (TEXT_EXTENSIONS.has(extension)) {
    return "text";
  }

  return "other";
}

function getExtension(name: string): string | null {
  const index = name.lastIndexOf(".");
  if (index === -1 || index === name.length - 1) {
    return null;
  }
  return name.slice(index + 1).toLowerCase();
}

function sortEntries(entries: ExplorerEntry[], sortOption: SortOption): ExplorerEntry[] {
  const sorted = [...entries];
  sorted.sort((a, b) => {
    if (a.kind !== b.kind) {
      return a.kind === "directory" ? -1 : 1;
    }
    switch (sortOption) {
      case "name":
        return a.name.localeCompare(b.name);
      case "modified":
        return new Date(b.modifiedAt).getTime() - new Date(a.modifiedAt).getTime();
      case "size":
        return b.size - a.size;
      default:
        return 0;
    }
  });
  return sorted;
}

function buildTreeRows({
  directories,
  expandedPaths,
  sortOption,
  path,
  depth,
}: {
  directories: Map<string, { path: string; entries: ExplorerEntry[] }>;
  expandedPaths: Set<string>;
  sortOption: SortOption;
  path: string;
  depth: number;
}): TreeRow[] {
  const directory = directories.get(path);
  if (!directory) {
    return [];
  }

  const rows: TreeRow[] = [];
  const entries = sortEntries(directory.entries, sortOption);

  for (const entry of entries) {
    rows.push({ entry, depth });
    if (entry.kind === "directory" && expandedPaths.has(entry.path)) {
      rows.push(
        ...buildTreeRows({
          directories,
          expandedPaths,
          sortOption,
          path: entry.path,
          depth: depth + 1,
        })
      );
    }
  }

  return rows;
}

function getParentDirectory(path: string): string {
  const normalized = path.replace(/\/+$/, "");
  if (!normalized || normalized === ".") {
    return ".";
  }
  const lastSlash = normalized.lastIndexOf("/");
  if (lastSlash === -1) {
    return ".";
  }
  const dir = normalized.slice(0, lastSlash);
  return dir.length > 0 ? dir : ".";
}

function getAncestorDirectories(directory: string): string[] {
  const trimmed = directory.replace(/^\.\/+/, "").replace(/\/+$/, "");
  if (!trimmed || trimmed === ".") {
    return ["."];
  }

  const parts = trimmed.split("/").filter(Boolean);
  const ancestors: string[] = ["."];
  let acc = "";
  for (const part of parts) {
    acc = acc ? `${acc}/${part}` : part;
    ancestors.push(acc);
  }
  return ancestors;
}

const styles = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
    backgroundColor: theme.colors.surface0,
  },
  desktopSplit: {
    flex: 1,
    flexDirection: "row",
    minHeight: 0,
  },
  treePane: {
    minWidth: 0,
  },
  treePaneFill: {
    flex: 1,
  },
  treePaneWithPreview: {
    flex: 0,
    flexGrow: 0,
    flexShrink: 0,
  },
  splitResizeHandle: {
    position: "absolute",
    left: -5,
    top: 0,
    bottom: 0,
    width: 10,
    zIndex: 20,
  },
  previewPane: {
    flex: 1,
    minWidth: 0,
    position: "relative",
    borderLeftWidth: 1,
    borderLeftColor: theme.colors.border,
  },
  paneHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    height: 32 + theme.spacing[2] * 2,
    paddingHorizontal: theme.spacing[3],
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
    backgroundColor: theme.colors.surface0,
  },
  paneHeaderLeft: {
    flex: 1,
    minWidth: 0,
  },
  previewHeaderRight: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    flexShrink: 0,
  },
  sortButton: {
    height: 32,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: theme.spacing[2],
    borderRadius: theme.borderRadius.md,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
  },
  sortButtonText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
  },
  treeList: {
    flex: 1,
    minHeight: 0,
  },
  entriesContent: {
    paddingBottom: theme.spacing[4],
  },
  centerState: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: theme.spacing[2],
    padding: theme.spacing[4],
  },
  loadingText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  errorText: {
    color: theme.colors.destructive,
    fontSize: theme.fontSize.base,
    textAlign: "center",
  },
  retryButton: {
    borderRadius: theme.borderRadius.full,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[1],
  },
  retryButtonText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.semibold,
  },
  emptyText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
    textAlign: "center",
  },
  entryRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingVertical: theme.spacing[1],
    paddingRight: theme.spacing[2],
  },
  entryRowActive: {
    backgroundColor: theme.colors.surface2,
  },
  entryInfo: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    minWidth: 0,
  },
  entryIcon: {
    flexShrink: 0,
  },
  entryName: {
    flex: 1,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
  },
  menuButton: {
    width: 36,
    height: 36,
    borderRadius: theme.borderRadius.full,
    alignItems: "center",
    justifyContent: "center",
  },
  menuButtonActive: {
    backgroundColor: theme.colors.surface2,
  },
  menuOverlay: {
    flex: 1,
  },
  menuBackdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "rgba(0, 0, 0, 0.2)",
  },
  entryMenu: {
    borderRadius: theme.borderRadius.lg,
    backgroundColor: theme.colors.surface1,
    overflow: "hidden",
    ...(Platform.OS === "web"
      ? ({ boxShadow: "0 10px 30px rgba(0, 0, 0, 0.35)" } as any)
      : {
          shadowColor: "#000",
          shadowOpacity: 0.35,
          shadowRadius: 16,
          shadowOffset: { width: 0, height: 10 },
          elevation: 14,
        }),
  },
  entryMenuHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    paddingVertical: theme.spacing[3],
    paddingHorizontal: theme.spacing[4],
  },
  entryMenuMeta: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  entryMenuDivider: {
    height: 1,
    backgroundColor: theme.colors.border,
  },
  entryMenuItem: {
    paddingVertical: theme.spacing[4],
    paddingHorizontal: theme.spacing[4],
  },
  entryMenuItemHovered: {
    backgroundColor: theme.colors.surface2,
  },
  entryMenuText: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.lg,
    fontWeight: theme.fontWeight.semibold,
  },
  previewHeaderText: {
    flex: 1,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.normal,
  },
  iconButton: {
    width: 32,
    height: 32,
    borderRadius: theme.borderRadius.md,
    alignItems: "center",
    justifyContent: "center",
  },
  iconButtonHovered: {
    backgroundColor: theme.colors.surface2,
  },
  previewContent: {
    flex: 1,
  },
  previewCodeScrollContent: {
    paddingTop: theme.spacing[3],
    paddingHorizontal: theme.spacing[3],
    paddingBottom: theme.spacing[3] + theme.spacing[2],
  },
  codeText: {
    color: theme.colors.foreground,
    fontFamily: Fonts.mono,
    fontSize: theme.fontSize.sm,
    lineHeight: 20,
    flexShrink: 0,
  },
  previewImageScrollContent: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: theme.spacing[3],
  },
  previewImage: {
    width: "100%",
    aspectRatio: 1,
  },
  sheetBackground: {
    backgroundColor: theme.colors.surface2,
  },
  handleIndicator: {
    backgroundColor: theme.colors.palette.zinc[600],
  },
  sheetHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[3],
    borderBottomWidth: theme.borderWidth[1],
    borderBottomColor: theme.colors.border,
  },
  sheetTitle: {
    fontSize: theme.fontSize.lg,
    fontWeight: theme.fontWeight.semibold,
    color: theme.colors.foreground,
    flex: 1,
  },
  sheetCloseButton: {
    padding: theme.spacing[2],
  },
  sheetCenterState: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: theme.spacing[2],
    padding: theme.spacing[4],
  },
}));
