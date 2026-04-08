import { useCallback, useEffect, useMemo, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  ActivityIndicator,
  FlatList,
  ListRenderItemInfo,
  Pressable,
  Text,
  View,
  Platform,
} from "react-native";
import { Gesture } from "react-native-gesture-handler";
import { StyleSheet, UnistylesRuntime, useUnistyles } from "react-native-unistyles";
import Animated, {
  cancelAnimation,
  Easing,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from "react-native-reanimated";
import { WORKSPACE_SECONDARY_HEADER_HEIGHT } from "@/constants/layout";
import { Fonts } from "@/constants/theme";
import * as Clipboard from "expo-clipboard";
import { SvgXml } from "react-native-svg";
import {
  ChevronDown,
  ChevronRight,
  Copy,
  Download,
  MoreVertical,
  RotateCw,
  X,
} from "lucide-react-native";
import { getFileIconSvg } from "@/components/material-file-icons";
import type { AgentFileExplorerState, ExplorerEntry } from "@/stores/session-store";
import { useHosts } from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";
import { useDownloadStore } from "@/stores/download-store";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useFileExplorerActions } from "@/hooks/use-file-explorer-actions";
import { buildWorkspaceExplorerStateKey } from "@/hooks/use-file-explorer-actions";
import { usePanelStore, type SortOption } from "@/stores/panel-store";
import { formatTimeAgo } from "@/utils/time";
import { buildAbsoluteExplorerPath } from "@/utils/explorer-paths";
import { useWebScrollViewScrollbar } from "@/components/use-web-scrollbar";

const SORT_OPTIONS: { value: SortOption; label: string }[] = [
  { value: "name", label: "Name" },
  { value: "modified", label: "Modified" },
  { value: "size", label: "Size" },
];

const INDENT_PER_LEVEL = 16;

function formatFileSize({ size }: { size: number }): string {
  if (size < 1024) {
    return `${size} B`;
  }
  if (size < 1024 * 1024) {
    return `${(size / 1024).toFixed(1)} KB`;
  }
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

interface FileExplorerPaneProps {
  serverId: string;
  workspaceId?: string | null;
  workspaceRoot: string;
  onOpenFile?: (filePath: string) => void;
}

interface TreeRow {
  entry: ExplorerEntry;
  depth: number;
}

export function FileExplorerPane({
  serverId,
  workspaceId,
  workspaceRoot,
  onOpenFile,
}: FileExplorerPaneProps) {
  const { theme } = useUnistyles();
  const isMobile = UnistylesRuntime.breakpoint === "xs" || UnistylesRuntime.breakpoint === "sm";
  const showDesktopWebScrollbar = Platform.OS === "web" && !isMobile;

  const daemons = useHosts();
  const daemonProfile = useMemo(
    () => daemons.find((daemon) => daemon.serverId === serverId),
    [daemons, serverId],
  );
  const normalizedWorkspaceRoot = useMemo(() => workspaceRoot.trim(), [workspaceRoot]);
  const workspaceStateKey = useMemo(
    () =>
      buildWorkspaceExplorerStateKey({
        workspaceId,
        workspaceRoot: normalizedWorkspaceRoot,
      }),
    [normalizedWorkspaceRoot, workspaceId],
  );
  const workspaceScopeId = useMemo(
    () => workspaceId?.trim() || normalizedWorkspaceRoot,
    [normalizedWorkspaceRoot, workspaceId],
  );
  const hasWorkspaceScope = Boolean(workspaceStateKey && normalizedWorkspaceRoot);
  const explorerState = useSessionStore((state) =>
    workspaceStateKey && state.sessions[serverId]
      ? state.sessions[serverId]?.fileExplorer.get(workspaceStateKey)
      : undefined,
  );

  const {
    requestDirectoryListing,
    requestFileDownloadToken,
    selectExplorerEntry,
  } = useFileExplorerActions({
    serverId,
    workspaceId,
    workspaceRoot: normalizedWorkspaceRoot,
  });
  const sortOption = usePanelStore((state) => state.explorerSortOption);
  const setSortOption = usePanelStore((state) => state.setExplorerSortOption);
  const expandedPathsArray = usePanelStore((state) =>
    workspaceStateKey ? state.expandedPathsByWorkspace[workspaceStateKey] : undefined,
  );
  const setExpandedPathsForWorkspace = usePanelStore(
    (state) => state.setExpandedPathsForWorkspace,
  );
  const expandedPaths = useMemo(
    () => new Set(expandedPathsArray && expandedPathsArray.length > 0 ? expandedPathsArray : ["."]),
    [expandedPathsArray],
  );

  const directories = explorerState?.directories ?? new Map();
  const pendingRequest = explorerState?.pendingRequest ?? null;
  const isExplorerLoading = explorerState?.isLoading ?? false;
  const error = explorerState?.lastError ?? null;
  const selectedEntryPath = explorerState?.selectedEntryPath ?? null;

  const isDirectoryLoading = useCallback(
    (path: string) =>
      Boolean(
        isExplorerLoading && pendingRequest?.mode === "list" && pendingRequest?.path === path,
      ),
    [isExplorerLoading, pendingRequest?.mode, pendingRequest?.path],
  );

  const treeListRef = useRef<FlatList<TreeRow>>(null);
  const scrollbar = useWebScrollViewScrollbar(treeListRef, {
    enabled: showDesktopWebScrollbar,
  });

  const hasInitializedRef = useRef(false);

  useEffect(() => {
    hasInitializedRef.current = false;
  }, [workspaceStateKey]);

  useEffect(() => {
    if (!hasWorkspaceScope) {
      return;
    }
    if (hasInitializedRef.current) {
      return;
    }
    hasInitializedRef.current = true;
    void requestDirectoryListing(".", {
      recordHistory: false,
      setCurrentPath: false,
    });
    const persistedPaths = usePanelStore.getState().expandedPathsByWorkspace[workspaceStateKey ?? ""];
    if (persistedPaths) {
      for (const path of persistedPaths) {
        if (path !== ".") {
          void requestDirectoryListing(path, {
            recordHistory: false,
            setCurrentPath: false,
          });
        }
      }
    }
  }, [hasWorkspaceScope, requestDirectoryListing, workspaceStateKey]);

  // Expand ancestor directories when a file is selected (e.g., from an inline path click)
  useEffect(() => {
    if (!selectedEntryPath || !workspaceStateKey) {
      return;
    }
    const parentDir = getParentDirectory(selectedEntryPath);
    const ancestors = getAncestorDirectories(parentDir);
    const newPaths = ancestors.filter((path) => !expandedPaths.has(path));
    if (newPaths.length === 0) {
      return;
    }
    setExpandedPathsForWorkspace(
      workspaceStateKey,
      [...Array.from(expandedPaths), ...newPaths],
    );
    newPaths.forEach((path) => {
      if (!directories.has(path)) {
        void requestDirectoryListing(path, {
          recordHistory: false,
          setCurrentPath: false,
        });
      }
    });
  }, [
    directories,
    workspaceStateKey,
    expandedPaths,
    requestDirectoryListing,
    selectedEntryPath,
    setExpandedPathsForWorkspace,
  ]);

  const handleToggleDirectory = useCallback(
    (entry: ExplorerEntry) => {
      if (!workspaceStateKey) {
        return;
      }
      const isExpanded = expandedPaths.has(entry.path);
      if (isExpanded) {
        setExpandedPathsForWorkspace(
          workspaceStateKey,
          Array.from(expandedPaths).filter((path) => path !== entry.path),
        );
      } else {
        setExpandedPathsForWorkspace(
          workspaceStateKey,
          [...Array.from(expandedPaths), entry.path],
        );
        if (!directories.has(entry.path)) {
          void requestDirectoryListing(entry.path, {
            recordHistory: false,
            setCurrentPath: false,
          });
        }
      }
    },
    [
      workspaceStateKey,
      expandedPaths,
      directories,
      requestDirectoryListing,
      setExpandedPathsForWorkspace,
    ],
  );

  const handleOpenFile = useCallback(
    (entry: ExplorerEntry) => {
      if (!hasWorkspaceScope) {
        return;
      }
      selectExplorerEntry(entry.path);
      onOpenFile?.(entry.path);
    },
    [hasWorkspaceScope, onOpenFile, selectExplorerEntry],
  );

  const handleEntryPress = useCallback(
    (entry: ExplorerEntry) => {
      if (entry.kind === "directory") {
        handleToggleDirectory(entry);
        return;
      }
      handleOpenFile(entry);
    },
    [handleOpenFile, handleToggleDirectory],
  );

  const handleCopyPath = useCallback(
    async (path: string) => {
      await Clipboard.setStringAsync(
        buildAbsoluteExplorerPath({
          workspaceRoot: normalizedWorkspaceRoot,
          entryPath: path,
        }),
      );
    },
    [normalizedWorkspaceRoot],
  );

  const startDownload = useDownloadStore((state) => state.startDownload);
  const handleDownloadEntry = useCallback(
    (entry: ExplorerEntry) => {
      if (!workspaceScopeId || entry.kind !== "file") {
        return;
      }

      startDownload({
        serverId,
        scopeId: workspaceScopeId,
        fileName: entry.name,
        path: entry.path,
        daemonProfile,
        requestFileDownloadToken: (targetPath) => requestFileDownloadToken(targetPath),
      });
    },
    [daemonProfile, requestFileDownloadToken, serverId, startDownload, workspaceScopeId],
  );

  const handleSortCycle = useCallback(() => {
    const currentIndex = SORT_OPTIONS.findIndex((opt) => opt.value === sortOption);
    const nextIndex = (currentIndex + 1) % SORT_OPTIONS.length;
    setSortOption(SORT_OPTIONS[nextIndex].value);
  }, [sortOption, setSortOption]);

  const { refetch: refetchExplorer, isFetching: isRefreshFetching } = useQuery({
    queryKey: ["fileExplorerRefresh", serverId, workspaceStateKey],
    queryFn: async () => {
      if (!hasWorkspaceScope) {
        return null;
      }

      const directoryPaths = Array.from(expandedPaths);
      if (!directoryPaths.includes(".")) {
        directoryPaths.unshift(".");
      }

      await Promise.all([
        ...directoryPaths.map((path) =>
          requestDirectoryListing(path, {
            recordHistory: false,
            setCurrentPath: false,
          }),
        ),
      ]);
      return null;
    },
    enabled: false,
  });

  const handleRefresh = useCallback(() => {
    void refetchExplorer();
  }, [refetchExplorer]);
  const refreshIconRotation = useSharedValue(0);

  useEffect(() => {
    if (isRefreshFetching) {
      refreshIconRotation.value = 0;
      refreshIconRotation.value = withRepeat(
        withTiming(360, {
          duration: 700,
          easing: Easing.linear,
        }),
        -1,
        false,
      );
      return;
    }

    cancelAnimation(refreshIconRotation);
    const remainder = refreshIconRotation.value % 360;
    if (Math.abs(remainder) < 0.001) {
      refreshIconRotation.value = 0;
      return;
    }

    const remaining = 360 - remainder;
    const duration = Math.max(80, Math.round((remaining / 360) * 700));
    refreshIconRotation.value = withTiming(
      360,
      {
        duration,
        easing: Easing.linear,
      },
      (finished) => {
        if (finished) {
          refreshIconRotation.value = 0;
        }
      },
    );
  }, [isRefreshFetching, refreshIconRotation]);

  const refreshIconAnimatedStyle = useAnimatedStyle(() => ({
    transform: [{ rotate: `${refreshIconRotation.value}deg` }],
  }));

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
  const showBackFromError = Boolean(error && selectedEntryPath);
  const errorRecoveryPath = useMemo(() => getErrorRecoveryPath(explorerState), [explorerState]);

  const renderTreeRow = useCallback(
    ({ item }: ListRenderItemInfo<TreeRow>) => {
      const entry = item.entry;
      const depth = item.depth;
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
          {depth > 0 &&
            Array.from({ length: depth }, (_, i) => (
              <View
                key={i}
                style={[
                  styles.indentGuide,
                  {
                    left: theme.spacing[3] + i * INDENT_PER_LEVEL + 4,
                  },
                ]}
              />
            ))}
          <View style={styles.entryInfo}>
            <View style={styles.entryIcon}>
              {isDirectory ? (
                loading ? (
                  <ActivityIndicator size="small" />
                ) : (
                  <View style={[styles.chevron, isExpanded && styles.chevronExpanded]}>
                    <ChevronRight size={16} color={theme.colors.foregroundMuted} />
                  </View>
                )
              ) : (
                <SvgXml xml={getFileIconSvg(entry.name)} width={16} height={16} />
              )}
            </View>
            <Text style={styles.entryName} numberOfLines={1}>
              {entry.name}
            </Text>
          </View>
          <DropdownMenu>
            <DropdownMenuTrigger
              hitSlop={8}
              onPressIn={(event) => event.stopPropagation?.()}
              style={({ hovered, pressed, open }) => [
                styles.menuButton,
                (hovered || pressed || open) && styles.menuButtonActive,
              ]}
            >
              <MoreVertical size={16} color={theme.colors.foregroundMuted} />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" width={220}>
              <View style={styles.contextMetaBlock}>
                <View style={styles.contextMetaRow}>
                  <Text style={styles.contextMetaLabel} numberOfLines={1}>
                    Size
                  </Text>
                  <Text style={styles.contextMetaValue} numberOfLines={1} ellipsizeMode="tail">
                    {formatFileSize({ size: entry.size })}
                  </Text>
                </View>
                <View style={styles.contextMetaRow}>
                  <Text style={styles.contextMetaLabel} numberOfLines={1}>
                    Modified
                  </Text>
                  <Text style={styles.contextMetaValue} numberOfLines={1} ellipsizeMode="tail">
                    {formatTimeAgo(new Date(entry.modifiedAt))}
                  </Text>
                </View>
              </View>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                leading={<Copy size={14} color={theme.colors.foregroundMuted} />}
                onSelect={() => {
                  void handleCopyPath(entry.path);
                }}
              >
                Copy path
              </DropdownMenuItem>
              {entry.kind === "file" ? (
                <DropdownMenuItem
                  leading={<Download size={14} color={theme.colors.foregroundMuted} />}
                  onSelect={() => handleDownloadEntry(entry)}
                >
                  Download
                </DropdownMenuItem>
              ) : null}
            </DropdownMenuContent>
          </DropdownMenu>
        </Pressable>
      );
    },
    [
      expandedPaths,
      handleEntryPress,
      handleCopyPath,
      handleDownloadEntry,
      isDirectoryLoading,
      selectedEntryPath,
      theme.colors,
      theme.spacing,
    ],
  );

  const handleBackFromError = useCallback(() => {
    if (!hasWorkspaceScope) {
      return;
    }
    selectExplorerEntry(null);
    void requestDirectoryListing(errorRecoveryPath, {
      recordHistory: false,
      setCurrentPath: true,
    });
  }, [errorRecoveryPath, hasWorkspaceScope, requestDirectoryListing, selectExplorerEntry]);

  if (!hasWorkspaceScope) {
    return (
      <View style={styles.centerState}>
        <Text style={styles.errorText}>Workspace is unavailable</Text>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      {error ? (
        <View style={styles.centerState}>
          <Text style={styles.errorText}>{error}</Text>
          <View style={styles.errorActions}>
            {showBackFromError ? (
              <Pressable style={styles.retryButton} onPress={handleBackFromError}>
                <Text style={styles.retryButtonText}>Back</Text>
              </Pressable>
            ) : null}
            <Pressable
              style={styles.retryButton}
              onPress={() => {
                void requestDirectoryListing(".", {
                  recordHistory: false,
                  setCurrentPath: false,
                });
              }}
            >
              <Text style={styles.retryButtonText}>Retry</Text>
            </Pressable>
          </View>
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
        <View style={[styles.treePane, styles.treePaneFill]}>
          <View style={styles.paneHeader} testID="files-pane-header">
            <Pressable
              onPress={handleSortCycle}
              style={({ hovered, pressed }) => [
                styles.sortTrigger,
                (hovered || pressed) && styles.sortTriggerHovered,
              ]}
            >
              <Text style={styles.sortTriggerText}>{currentSortLabel}</Text>
              <ChevronDown size={12} color={theme.colors.foregroundMuted} />
            </Pressable>
            <Pressable
              onPress={handleRefresh}
              disabled={isRefreshFetching}
              hitSlop={8}
              style={({ hovered, pressed }) => [
                styles.iconButton,
                (hovered || pressed) && styles.iconButtonHovered,
              ]}
              accessibilityRole="button"
              accessibilityLabel="Refresh files"
            >
              <Animated.View style={[styles.refreshIcon, refreshIconAnimatedStyle]}>
                <RotateCw size={theme.iconSize.sm} color={theme.colors.foregroundMuted} />
              </Animated.View>
            </Pressable>
          </View>
          <FlatList
            ref={treeListRef}
            style={styles.treeList}
            data={treeRows}
            renderItem={renderTreeRow}
            keyExtractor={(row) => row.entry.path}
            testID="file-explorer-tree-scroll"
            contentContainerStyle={styles.entriesContent}
            onLayout={scrollbar.onLayout}
            onScroll={scrollbar.onScroll}
            onContentSizeChange={scrollbar.onContentSizeChange}
            scrollEventThrottle={16}
            showsVerticalScrollIndicator={!showDesktopWebScrollbar}
            initialNumToRender={24}
            maxToRenderPerBatch={40}
            windowSize={12}
          />
          {scrollbar.overlay}
        </View>
      )}
    </View>
  );
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
        }),
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

function getErrorRecoveryPath(state: AgentFileExplorerState | undefined): string {
  if (!state) {
    return ".";
  }

  const currentHistoryPath =
    state.history.length > 0 ? state.history[state.history.length - 1] : null;
  const candidate = currentHistoryPath ?? state.lastVisitedPath ?? state.currentPath;

  if (!candidate || candidate.length === 0) {
    return ".";
  }
  return candidate;
}

const styles = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
    backgroundColor: theme.colors.surfaceSidebar,
  },
  desktopSplit: {
    flex: 1,
    flexDirection: "row",
    minHeight: 0,
  },
  treePane: {
    minWidth: 0,
    position: "relative",
  },
  treePaneFill: {
    flex: 1,
  },
  treePaneWithPreview: {
    flex: 0,
    flexGrow: 0,
    flexShrink: 0,
    borderLeftWidth: 1,
    borderLeftColor: theme.colors.border,
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
  },
  paneHeader: {
    height: WORKSPACE_SECONDARY_HEADER_HEIGHT,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingRight: theme.spacing[3],
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
  },
  sortTrigger: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: theme.spacing[1],
    marginLeft: theme.spacing[3] - theme.spacing[1],
    paddingHorizontal: theme.spacing[1],
    height: 24,
    borderRadius: theme.borderRadius.base,
  },
  sortTriggerHovered: {
    backgroundColor: theme.colors.surface2,
  },
  sortTriggerText: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
  },
  treeList: {
    flex: 1,
    minHeight: 0,
  },
  entriesContent: {
    paddingHorizontal: theme.spacing[2],
    paddingTop: theme.spacing[2],
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
  errorActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  emptyText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
    textAlign: "center",
  },
  binaryMetaText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  entryRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingVertical: 2,
    paddingRight: theme.spacing[2],
    borderRadius: theme.borderRadius.md,
  },
  entryRowActive: {
    backgroundColor: theme.colors.surface1,
  },
  indentGuide: {
    position: "absolute",
    top: 0,
    bottom: 0,
    width: 1,
    backgroundColor: theme.colors.surface2,
  },
  entryInfo: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    minWidth: 0,
  },
  chevron: {
    width: 16,
    height: 16,
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },
  chevronExpanded: {
    transform: [{ rotate: "90deg" }],
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
    width: 30,
    height: 30,
    borderRadius: theme.borderRadius.full,
    alignItems: "center",
    justifyContent: "center",
  },
  menuButtonActive: {
    backgroundColor: theme.colors.surface2,
  },
  contextMetaBlock: {
    paddingVertical: theme.spacing[1],
  },
  contextMetaRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    minHeight: 32,
    paddingHorizontal: theme.spacing[3],
  },
  contextMetaLabel: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
    flexShrink: 0,
  },
  contextMetaValue: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foreground,
    fontWeight: theme.fontWeight.medium,
    flex: 1,
    minWidth: 0,
    textAlign: "right",
  },
  previewHeaderText: {
    flex: 1,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.normal,
  },
  iconButton: {
    width: 22,
    height: 22,
    borderRadius: theme.borderRadius.md,
    alignItems: "center",
    justifyContent: "center",
  },
  iconButtonHovered: {
    backgroundColor: theme.colors.surface2,
  },
  refreshIcon: {
    width: 16,
    height: 16,
    alignItems: "center",
    justifyContent: "center",
  },
  previewContent: {
    flex: 1,
  },
  previewScrollContainer: {
    flex: 1,
    minHeight: 0,
    position: "relative",
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
