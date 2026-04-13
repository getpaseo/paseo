import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ActivityIndicator,
  FlatList,
  ListRenderItemInfo,
  Pressable,
  Text,
  TextInput,
  View,
} from "react-native";
import { Gesture } from "react-native-gesture-handler";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { useIsCompactFormFactor } from "@/constants/layout";
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
  ExternalLink,
  FolderOpen,
  MoreVertical,
  Pencil,
  RotateCw,
  Search,
  Trash2,
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
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { useFileExplorerActions } from "@/hooks/use-file-explorer-actions";
import { buildWorkspaceExplorerStateKey } from "@/hooks/use-file-explorer-actions";
import { usePanelStore, type SortOption } from "@/stores/panel-store";
import { formatTimeAgo } from "@/utils/time";
import { buildAbsoluteExplorerPath } from "@/utils/explorer-paths";
import { useWebScrollViewScrollbar } from "@/components/use-web-scrollbar";
import { getIsElectron, isWeb } from "@/constants/platform";
import { getDesktopHost } from "@/desktop/host";
import { AdaptiveModalSheet, AdaptiveTextInput } from "@/components/adaptive-modal-sheet";
import { Button } from "@/components/ui/button";

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
  const isMobile = useIsCompactFormFactor();
  const showDesktopWebScrollbar = isWeb && !isMobile;

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

  const { requestDirectoryListing, requestFileDownloadToken, selectExplorerEntry } =
    useFileExplorerActions({
      serverId,
      workspaceId,
      workspaceRoot: normalizedWorkspaceRoot,
    });

  const client = useSessionStore((state) => state.sessions[serverId]?.client ?? null);
  const queryClient = useQueryClient();
  const isElectron = getIsElectron();

  const refreshExplorerDir = useCallback(
    (dirPath: string) => {
      void requestDirectoryListing(dirPath, { recordHistory: false, setCurrentPath: false });
    },
    [requestDirectoryListing],
  );

  const renameMutation = useMutation({
    mutationFn: async ({ oldPath, newPath }: { oldPath: string; newPath: string }) => {
      if (!client) throw new Error("Not connected");
      const result = await client.renameFile(normalizedWorkspaceRoot, oldPath, newPath);
      if (result.error) throw new Error(result.error);
      return result;
    },
    onSuccess: (_data, { oldPath }) => {
      const parentDir = oldPath.includes("/") ? oldPath.split("/").slice(0, -1).join("/") : ".";
      refreshExplorerDir(parentDir);
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async ({ path }: { path: string }) => {
      if (!client) throw new Error("Not connected");
      const result = await client.deleteFile(normalizedWorkspaceRoot, path);
      if (result.error) throw new Error(result.error);
      return result;
    },
    onSuccess: (_data, { path }) => {
      const parentDir = path.includes("/") ? path.split("/").slice(0, -1).join("/") : ".";
      refreshExplorerDir(parentDir);
      void queryClient.invalidateQueries({ queryKey: ["workspaceFile", serverId] });
    },
  });

  const [renamingEntry, setRenamingEntry] = useState<ExplorerEntry | null>(null);
  const [renamingName, setRenamingName] = useState("");

  const handleRename = useCallback((entry: ExplorerEntry) => {
    setRenamingEntry(entry);
    setRenamingName(entry.name);
  }, []);

  const handleRenameSubmit = useCallback(() => {
    if (!renamingEntry) return;
    const newName = renamingName.trim();
    setRenamingEntry(null);
    if (!newName || newName === renamingEntry.name) return;
    const parentDir = renamingEntry.path.includes("/")
      ? renamingEntry.path.split("/").slice(0, -1).join("/")
      : null;
    const newPath = parentDir ? `${parentDir}/${newName}` : newName;
    renameMutation.mutate({ oldPath: renamingEntry.path, newPath });
  }, [renameMutation, renamingEntry, renamingName]);

  const handleRenameClose = useCallback(() => {
    setRenamingEntry(null);
  }, []);

  const handleDelete = useCallback(
    (entry: ExplorerEntry) => {
      const confirmed = window.confirm(
        `Delete "${entry.name}"?${entry.kind === "directory" ? "\nThis will delete the folder and all its contents." : ""}`,
      );
      if (!confirmed) return;
      deleteMutation.mutate({ path: entry.path });
    },
    [deleteMutation],
  );

  const handleRevealInFinder = useCallback(
    (entry: ExplorerEntry) => {
      const absolutePath = buildAbsoluteExplorerPath({
        workspaceRoot: normalizedWorkspaceRoot,
        entryPath: entry.path,
      });
      void getDesktopHost()?.invoke?.("reveal_in_finder", { absolutePath });
    },
    [normalizedWorkspaceRoot],
  );

  const handleOpenInTerminal = useCallback(
    (entry: ExplorerEntry) => {
      const entryPath = buildAbsoluteExplorerPath({
        workspaceRoot: normalizedWorkspaceRoot,
        entryPath: entry.path,
      });
      const directory =
        entry.kind === "directory"
          ? entryPath
          : entryPath.split("/").slice(0, -1).join("/") || normalizedWorkspaceRoot;
      void getDesktopHost()?.invoke?.("open_in_terminal", { directory });
    },
    [normalizedWorkspaceRoot],
  );

  const handleCopyRelativePath = useCallback(async (entryPath: string) => {
    await Clipboard.setStringAsync(entryPath);
  }, []);
  const sortOption = usePanelStore((state) => state.explorerSortOption);
  const setSortOption = usePanelStore((state) => state.setExplorerSortOption);
  const expandedPathsArray = usePanelStore((state) =>
    workspaceStateKey ? state.expandedPathsByWorkspace[workspaceStateKey] : undefined,
  );
  const setExpandedPathsForWorkspace = usePanelStore((state) => state.setExpandedPathsForWorkspace);
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

  const [searchQuery, setSearchQuery] = useState("");
  const [isSearchVisible, setIsSearchVisible] = useState(false);
  const searchInputRef = useRef<TextInput>(null);

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
    const persistedPaths =
      usePanelStore.getState().expandedPathsByWorkspace[workspaceStateKey ?? ""];
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
    setExpandedPathsForWorkspace(workspaceStateKey, [...Array.from(expandedPaths), ...newPaths]);
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
        setExpandedPathsForWorkspace(workspaceStateKey, [...Array.from(expandedPaths), entry.path]);
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

  const handleToggleSearch = useCallback(() => {
    setIsSearchVisible((prev) => {
      if (prev) {
        setSearchQuery("");
        return false;
      }
      setTimeout(() => searchInputRef.current?.focus(), 50);
      return true;
    });
  }, []);

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

  const filteredTreeRows = useMemo(() => {
    if (!searchQuery.trim()) return treeRows;
    const query = searchQuery.trim().toLowerCase();
    // When searching, show all matching files flattened (depth 0) regardless of expansion state
    const matchingRows: TreeRow[] = [];
    // Collect all entries recursively from all directories
    const allEntries: ExplorerEntry[] = [];
    for (const [, dir] of directories) {
      for (const entry of dir.entries) {
        allEntries.push(entry);
      }
    }
    for (const entry of allEntries) {
      const name = entry.name.toLowerCase();
      const path = entry.path.toLowerCase();
      if (name.includes(query) || path.includes(query)) {
        matchingRows.push({ entry, depth: 0 });
      }
    }
    // Sort by relevance: exact name match first, then starts-with, then includes
    matchingRows.sort((a, b) => {
      const aName = a.entry.name.toLowerCase();
      const bName = b.entry.name.toLowerCase();
      const aExact = aName === query ? 0 : aName.startsWith(query) ? 1 : 2;
      const bExact = bName === query ? 0 : bName.startsWith(query) ? 1 : 2;
      if (aExact !== bExact) return aExact - bExact;
      return aName.localeCompare(bName);
    });
    return matchingRows;
  }, [treeRows, searchQuery, directories]);

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

      const dropdownMenuItems = (
        <>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            leading={<Pencil size={14} color={theme.colors.foregroundMuted} />}
            onSelect={() => handleRename(entry)}
          >
            Rename
          </DropdownMenuItem>
          <DropdownMenuItem
            leading={<Trash2 size={14} color={theme.colors.destructive} />}
            onSelect={() => handleDelete(entry)}
            destructive
          >
            Delete
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            leading={<Copy size={14} color={theme.colors.foregroundMuted} />}
            onSelect={() => {
              void handleCopyPath(entry.path);
            }}
          >
            Copy path
          </DropdownMenuItem>
          <DropdownMenuItem
            leading={<Copy size={14} color={theme.colors.foregroundMuted} />}
            onSelect={() => {
              void handleCopyRelativePath(entry.path);
            }}
          >
            Copy relative path
          </DropdownMenuItem>
          {isElectron ? (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                leading={<FolderOpen size={14} color={theme.colors.foregroundMuted} />}
                onSelect={() => handleOpenInTerminal(entry)}
              >
                Open in Terminal
              </DropdownMenuItem>
              <DropdownMenuItem
                leading={<ExternalLink size={14} color={theme.colors.foregroundMuted} />}
                onSelect={() => handleRevealInFinder(entry)}
              >
                Reveal in Finder
              </DropdownMenuItem>
            </>
          ) : null}
          {entry.kind === "file" ? (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                leading={<Download size={14} color={theme.colors.foregroundMuted} />}
                onSelect={() => handleDownloadEntry(entry)}
              >
                Download
              </DropdownMenuItem>
            </>
          ) : null}
        </>
      );

      const contextMenuItems = (
        <>
          <ContextMenuItem
            leading={<Pencil size={14} color={theme.colors.foregroundMuted} />}
            onSelect={() => handleRename(entry)}
          >
            Rename
          </ContextMenuItem>
          <ContextMenuItem
            leading={<Trash2 size={14} color={theme.colors.destructive} />}
            onSelect={() => handleDelete(entry)}
            destructive
          >
            Delete
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem
            leading={<Copy size={14} color={theme.colors.foregroundMuted} />}
            onSelect={() => {
              void handleCopyPath(entry.path);
            }}
          >
            Copy path
          </ContextMenuItem>
          <ContextMenuItem
            leading={<Copy size={14} color={theme.colors.foregroundMuted} />}
            onSelect={() => {
              void handleCopyRelativePath(entry.path);
            }}
          >
            Copy relative path
          </ContextMenuItem>
          {isElectron ? (
            <>
              <ContextMenuSeparator />
              <ContextMenuItem
                leading={<FolderOpen size={14} color={theme.colors.foregroundMuted} />}
                onSelect={() => handleOpenInTerminal(entry)}
              >
                Open in Terminal
              </ContextMenuItem>
              <ContextMenuItem
                leading={<ExternalLink size={14} color={theme.colors.foregroundMuted} />}
                onSelect={() => handleRevealInFinder(entry)}
              >
                Reveal in Finder
              </ContextMenuItem>
            </>
          ) : null}
          {entry.kind === "file" ? (
            <>
              <ContextMenuSeparator />
              <ContextMenuItem
                leading={<Download size={14} color={theme.colors.foregroundMuted} />}
                onSelect={() => handleDownloadEntry(entry)}
              >
                Download
              </ContextMenuItem>
            </>
          ) : null}
        </>
      );

      return (
        <ContextMenu key={entry.path}>
          <ContextMenuTrigger
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
                {dropdownMenuItems}
              </DropdownMenuContent>
            </DropdownMenu>
          </ContextMenuTrigger>
          <ContextMenuContent side="bottom" align="start" width={220}>
            {contextMenuItems}
          </ContextMenuContent>
        </ContextMenu>
      );
    },
    [
      expandedPaths,
      handleEntryPress,
      handleCopyPath,
      handleCopyRelativePath,
      handleDownloadEntry,
      handleRename,
      handleDelete,
      handleRevealInFinder,
      handleOpenInTerminal,
      isDirectoryLoading,
      isElectron,
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
          <View style={styles.paneHeaderContainer} testID="files-pane-header">
            <View style={styles.paneHeader}>
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
              <View style={styles.paneHeaderActions}>
                <Pressable
                  onPress={handleToggleSearch}
                  hitSlop={8}
                  style={({ hovered, pressed }) => [
                    styles.iconButton,
                    isSearchVisible && styles.iconButtonActive,
                    (hovered || pressed) && styles.iconButtonHovered,
                  ]}
                  accessibilityRole="button"
                  accessibilityLabel="Search files"
                >
                  <Search size={theme.iconSize.sm} color={theme.colors.foregroundMuted} />
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
            </View>
            {isSearchVisible ? (
              <View style={styles.searchRow}>
                <Search size={14} color={theme.colors.foregroundMuted} style={styles.searchIcon} />
                <TextInput
                  ref={searchInputRef}
                  style={styles.searchInput}
                  value={searchQuery}
                  onChangeText={setSearchQuery}
                  placeholder="Search files..."
                  placeholderTextColor={theme.colors.foregroundMuted}
                  autoCapitalize="none"
                  autoCorrect={false}
                  returnKeyType="search"
                />
                {searchQuery.length > 0 ? (
                  <Pressable
                    onPress={() => setSearchQuery("")}
                    hitSlop={6}
                    style={styles.searchClear}
                  >
                    <X size={12} color={theme.colors.foregroundMuted} />
                  </Pressable>
                ) : null}
              </View>
            ) : null}
          </View>
          {filteredTreeRows.length === 0 && searchQuery.trim() ? (
            <View style={styles.centerState}>
              <Text style={styles.emptyText}>No matching files</Text>
            </View>
          ) : (
            <FlatList
              ref={treeListRef}
              style={styles.treeList}
              data={filteredTreeRows}
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
          )}
          {scrollbar.overlay}
        </View>
      )}
      <AdaptiveModalSheet
        title="Rename"
        visible={renamingEntry !== null}
        onClose={handleRenameClose}
        snapPoints={["30%"]}
      >
        <AdaptiveTextInput
          autoFocus
          value={renamingName}
          onChangeText={setRenamingName}
          onSubmitEditing={handleRenameSubmit}
          selectTextOnFocus
          style={styles.renameInput}
        />
        <View style={styles.renameActions}>
          <Button variant="outline" size="sm" onPress={handleRenameClose}>
            Cancel
          </Button>
          <Button
            variant="default"
            size="sm"
            onPress={handleRenameSubmit}
            disabled={!renamingName.trim() || renamingName.trim() === renamingEntry?.name}
          >
            Rename
          </Button>
        </View>
      </AdaptiveModalSheet>
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
  paneHeaderContainer: {
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
  },
  paneHeader: {
    height: WORKSPACE_SECONDARY_HEADER_HEIGHT,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingRight: theme.spacing[3],
  },
  paneHeaderActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
  },
  searchRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: theme.spacing[2],
    paddingBottom: theme.spacing[2],
    gap: theme.spacing[1],
  },
  searchIcon: {
    flexShrink: 0,
    marginLeft: theme.spacing[1],
  },
  searchInput: {
    flex: 1,
    height: 28,
    backgroundColor: theme.colors.surface0,
    borderRadius: theme.borderRadius.base,
    borderWidth: 1,
    borderColor: theme.colors.border,
    paddingHorizontal: theme.spacing[2],
    paddingVertical: 0,
    fontSize: theme.fontSize.sm,
    color: theme.colors.foreground,
    outlineStyle: "none",
  },
  searchClear: {
    width: 20,
    height: 20,
    borderRadius: theme.borderRadius.full,
    alignItems: "center",
    justifyContent: "center",
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
    backgroundColor: theme.colors.surfaceSidebarHover,
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
  renameInput: {
    color: theme.colors.foreground,
    backgroundColor: theme.colors.surface0,
    borderRadius: theme.borderRadius.md,
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[3],
    fontSize: theme.fontSize.sm,
    fontFamily: Fonts.mono,
    borderWidth: 1,
    borderColor: theme.colors.borderAccent,
    outlineStyle: "none",
  },
  renameActions: {
    flexDirection: "row",
    justifyContent: "flex-end",
    gap: theme.spacing[2],
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
  iconButtonActive: {
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
