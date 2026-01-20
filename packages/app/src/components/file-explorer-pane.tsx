import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  Image as RNImage,
  LayoutChangeEvent,
  ListRenderItemInfo,
  RefreshControl,
  ViewToken,
  NativeScrollEvent,
  NativeSyntheticEvent,
  Modal,
  Pressable,
  ScrollView,
  Text,
  View,
  useWindowDimensions,
} from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { Fonts } from "@/constants/theme";
import * as Clipboard from "expo-clipboard";
import {
  BottomSheetModal,
  BottomSheetScrollView,
  BottomSheetBackdrop,
  BottomSheetView,
} from "@gorhom/bottom-sheet";
import {
  ChevronDown,
  Download,
  File,
  FileText,
  Folder,
  Image as ImageIcon,
  MoreVertical,
  X,
} from "lucide-react-native";
import type { ExplorerEntry } from "@/stores/session-store";
import { useDaemonConnections } from "@/contexts/daemon-connections-context";
import { useSessionStore } from "@/stores/session-store";
import { useDownloadStore } from "@/stores/download-store";
import {
  usePanelStore,
  type SortOption,
} from "@/stores/panel-store";
import { formatTimeAgo } from "@/utils/time";

const MAX_CONCURRENT_THUMBNAILS = 2;
const THUMBNAIL_TIMEOUT_MS = 15000;

const SORT_OPTIONS: { value: SortOption; label: string }[] = [
  { value: "name", label: "Name" },
  { value: "modified", label: "Modified" },
  { value: "size", label: "Size" },
];

interface FileExplorerPaneProps {
  serverId: string;
  agentId: string;
}

export function FileExplorerPane({
  serverId,
  agentId,
}: FileExplorerPaneProps) {
  const { theme } = useUnistyles();
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

  const methods = useSessionStore((state) => state.sessions[serverId]?.methods);
  const requestDirectoryListing = methods?.requestDirectoryListing;
  const requestFilePreview = methods?.requestFilePreview;
  const requestFileDownloadToken = methods?.requestFileDownloadToken;
  const navigateExplorerBack = methods?.navigateExplorerBack;
  const viewMode = usePanelStore((state) => state.explorerViewMode);
  const sortOption = usePanelStore((state) => state.explorerSortOption);
  const setSortOption = usePanelStore((state) => state.setExplorerSortOption);
  const [selectedEntryPath, setSelectedEntryPath] = useState<string | null>(null);
  const listScrollRef = useRef<FlatList<ExplorerEntry> | null>(null);
  const listScrollOffsetRef = useRef(0);
  const scrollOffsetsByPathRef = useRef<Map<string, number>>(new Map());
  const pendingScrollRestoreRef = useRef<number | null>(null);
  const { width: windowWidth, height: windowHeight } = useWindowDimensions();

  const history = explorerState?.history ?? [];
  const lastKnownDirectory = history[history.length - 1];
  const rememberedDirectory = explorerState?.lastVisitedPath;
  const initialTargetDirectory = rememberedDirectory ?? lastKnownDirectory ?? ".";
  const currentPath = explorerState?.currentPath ?? ".";
  const pendingRequest = explorerState?.pendingRequest ?? null;
  const isExplorerLoading = explorerState?.isLoading ?? false;
  const isListingLoading = Boolean(
    isExplorerLoading && pendingRequest?.mode === "list"
  );
  const pendingDirectoryPath =
    isListingLoading && pendingRequest ? pendingRequest.path : null;
  const activePath = pendingDirectoryPath ?? currentPath;
  const directory = explorerState?.directories.get(activePath);
  const rawEntries = directory?.entries ?? [];
  const entries = useMemo(() => {
    const sorted = [...rawEntries];
    sorted.sort((a, b) => {
      // Directories always come first
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
  }, [rawEntries, sortOption]);
  const showInitialListLoading = isListingLoading && entries.length === 0;
  const isPreviewLoading = Boolean(
    isExplorerLoading &&
      pendingRequest?.mode === "file" &&
      pendingRequest?.path === selectedEntryPath
  );
  const error = explorerState?.lastError ?? null;
  const preview = selectedEntryPath
    ? explorerState?.files.get(selectedEntryPath)
    : null;
  const shouldShowPreview = Boolean(selectedEntryPath);
  const [thumbnailLoadingMap, setThumbnailLoadingMap] = useState<Record<string, boolean>>({});
  const viewabilityConfigRef = useRef({
    itemVisiblePercentThreshold: 10,
    minimumViewTime: 0,
  });

  // Bottom sheet for file preview
  const previewSheetRef = useRef<BottomSheetModal>(null);
  const previewSnapPoints = useMemo(() => ["70%", "95%"], []);

  // Thumbnail queue state
  const thumbnailQueueRef = useRef<string[]>([]);
  const inFlightPathsRef = useRef<Set<string>>(new Set());

  // Responsive gallery columns based on container width
  const [containerWidth, setContainerWidth] = useState(0);
  const gridColumnCount = containerWidth > 0 && containerWidth >= 400 ? 4 : 3;
  const listColumns = viewMode === "grid" ? gridColumnCount : 1;
  const listKey = viewMode === "grid" ? `grid-${gridColumnCount}` : "list";
  const [menuEntry, setMenuEntry] = useState<ExplorerEntry | null>(null);
  const [menuAnchor, setMenuAnchor] = useState({ top: 0, left: 0 });
  const [menuHeight, setMenuHeight] = useState(0);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const startDownload = useDownloadStore((state) => state.startDownload);
  const agentIdRef = useRef(agentId);
  const viewModeRef = useRef(viewMode);
  const requestFilePreviewRef = useRef(requestFilePreview);
  const explorerFilesRef = useRef(explorerState?.files);
  const refreshPathRef = useRef<string | null>(null);
  const refreshStartedRef = useRef(false);
  const hasInitializedRef = useRef(false);

  useEffect(() => {
    agentIdRef.current = agentId;
  }, [agentId]);

  useEffect(() => {
    viewModeRef.current = viewMode;
  }, [viewMode]);

  useEffect(() => {
    requestFilePreviewRef.current = requestFilePreview;
  }, [requestFilePreview]);

  useEffect(() => {
    explorerFilesRef.current = explorerState?.files;
  }, [explorerState?.files]);

  // Process items from the thumbnail queue
  const processNextThumbnail = useCallback(() => {
    const currentAgentId = agentIdRef.current;
    const currentRequestFilePreview = requestFilePreviewRef.current;

    if (!currentAgentId || !currentRequestFilePreview) {
      return;
    }

    while (
      inFlightPathsRef.current.size < MAX_CONCURRENT_THUMBNAILS &&
      thumbnailQueueRef.current.length > 0
    ) {
      const path = thumbnailQueueRef.current.shift()!;

      if (explorerFilesRef.current?.has(path) || inFlightPathsRef.current.has(path)) {
        continue;
      }

      inFlightPathsRef.current.add(path);
      setThumbnailLoadingMap((prev) => ({ ...prev, [path]: true }));
      currentRequestFilePreview(currentAgentId, path);

      setTimeout(() => {
        if (inFlightPathsRef.current.has(path)) {
          inFlightPathsRef.current.delete(path);
          setThumbnailLoadingMap((prev) => {
            const next = { ...prev };
            delete next[path];
            return next;
          });
          processNextThumbnail();
        }
      }, THUMBNAIL_TIMEOUT_MS);
    }
  }, []);

  // Enqueue a file preview request
  const enqueueFilePreview = useCallback(
    (path: string, options?: { priority?: boolean }) => {
      const currentAgentId = agentIdRef.current;
      const currentRequestFilePreview = requestFilePreviewRef.current;

      if (!currentAgentId || !currentRequestFilePreview) {
        return;
      }

      if (explorerFilesRef.current?.has(path)) {
        return;
      }

      if (options?.priority) {
        thumbnailQueueRef.current = [];

        if (inFlightPathsRef.current.has(path)) {
          return;
        }

        if (inFlightPathsRef.current.size > 0) {
          const abandonedPaths = Array.from(inFlightPathsRef.current);
          setThumbnailLoadingMap((prev) => {
            const next = { ...prev };
            abandonedPaths.forEach((p) => delete next[p]);
            return next;
          });
          inFlightPathsRef.current.clear();
        }

        inFlightPathsRef.current.add(path);
        setThumbnailLoadingMap((prev) => ({ ...prev, [path]: true }));
        currentRequestFilePreview(currentAgentId, path);

        setTimeout(() => {
          if (inFlightPathsRef.current.has(path)) {
            inFlightPathsRef.current.delete(path);
            setThumbnailLoadingMap((prev) => {
              const next = { ...prev };
              delete next[path];
              return next;
            });
            processNextThumbnail();
          }
        }, THUMBNAIL_TIMEOUT_MS);

        return;
      }

      if (
        !thumbnailQueueRef.current.includes(path) &&
        !inFlightPathsRef.current.has(path)
      ) {
        thumbnailQueueRef.current.push(path);
        processNextThumbnail();
      }
    },
    [processNextThumbnail]
  );

  const handleViewableItemsChangedRef = useRef(
    ({ viewableItems }: { viewableItems: Array<ViewToken> }) => {
      const currentViewMode = viewModeRef.current;

      if (currentViewMode !== "grid") {
        return;
      }

      viewableItems.forEach((token) => {
        const item = token.item as ExplorerEntry | undefined;
        if (!item || getEntryDisplayKind(item) !== "image") {
          return;
        }
        enqueueFilePreviewRef.current?.(item.path);
      });
    }
  );

  const enqueueFilePreviewRef = useRef(enqueueFilePreview);
  useEffect(() => {
    enqueueFilePreviewRef.current = enqueueFilePreview;
  }, [enqueueFilePreview]);

  const restoreQueuedScrollOffset = useCallback(() => {
    if (pendingScrollRestoreRef.current === null) {
      return;
    }

    if (!listScrollRef.current) {
      return;
    }

    const targetOffset = pendingScrollRestoreRef.current;
    listScrollRef.current.scrollToOffset({ offset: targetOffset, animated: false });
    listScrollOffsetRef.current = targetOffset;
    pendingScrollRestoreRef.current = null;
  }, []);

  const queueScrollRestore = useCallback((offset: number) => {
    pendingScrollRestoreRef.current = offset;
    requestAnimationFrame(restoreQueuedScrollOffset);
  }, [restoreQueuedScrollOffset]);

  useEffect(() => {
    setSelectedEntryPath(null);
  }, [activePath]);

  // Open/close preview sheet based on selection
  useEffect(() => {
    if (selectedEntryPath) {
      previewSheetRef.current?.present();
    } else {
      previewSheetRef.current?.dismiss();
    }
  }, [selectedEntryPath]);

  useEffect(() => {
    if (shouldShowPreview) {
      return;
    }

    const savedOffset = scrollOffsetsByPathRef.current.get(activePath) ?? listScrollOffsetRef.current;
    queueScrollRestore(savedOffset);
  }, [activePath, queueScrollRestore, shouldShowPreview]);

  useEffect(() => {
    const savedOffset = scrollOffsetsByPathRef.current.get(activePath) ?? 0;
    listScrollOffsetRef.current = savedOffset;
    queueScrollRestore(savedOffset);
  }, [activePath, queueScrollRestore]);

  // Initial directory listing request
  useEffect(() => {
    if (!agentId || !requestDirectoryListing) {
      return;
    }

    if (hasInitializedRef.current) {
      return;
    }
    hasInitializedRef.current = true;

    requestDirectoryListing(agentId, initialTargetDirectory);
  }, [agentId, initialTargetDirectory, requestDirectoryListing]);

  const handleEntryPress = useCallback(
    (entry: ExplorerEntry) => {
      if (!agentId || !requestDirectoryListing) {
        return;
      }

      if (entry.kind === "directory") {
        setSelectedEntryPath(null);
        requestDirectoryListing(agentId, entry.path);
        return;
      }

      setSelectedEntryPath(entry.path);
      enqueueFilePreview(entry.path, { priority: true });
    },
    [agentId, requestDirectoryListing, enqueueFilePreview]
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
    const menuWidth = 180;
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
  }, [menuEntry, menuAnchor.left, menuAnchor.top, menuHeight, theme.spacing, windowHeight, windowWidth]);

  const handleListScroll = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      const offset = event.nativeEvent.contentOffset.y;
      listScrollOffsetRef.current = offset;
      scrollOffsetsByPathRef.current.set(activePath, offset);
    },
    [activePath]
  );

  const handleContainerLayout = useCallback((event: LayoutChangeEvent) => {
    const { width } = event.nativeEvent.layout;
    setContainerWidth(width);
  }, []);

  const handleClosePreviewSheet = useCallback(() => {
    setSelectedEntryPath(null);
  }, []);

  const handlePreviewSheetChange = useCallback((index: number) => {
    if (index === -1) {
      setSelectedEntryPath(null);
    }
  }, []);

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

  const handleRetryDirectory = useCallback(() => {
    if (!agentId || !requestDirectoryListing) {
      return;
    }
    requestDirectoryListing(agentId, activePath);
  }, [agentId, requestDirectoryListing, activePath]);

  const handleRefresh = useCallback(() => {
    if (!agentId || !requestDirectoryListing) {
      return;
    }
    refreshPathRef.current = activePath;
    refreshStartedRef.current = false;
    setIsRefreshing(true);
    requestDirectoryListing(agentId, activePath, { recordHistory: false });
  }, [agentId, requestDirectoryListing, activePath]);

  useEffect(() => {
    if (!isRefreshing) {
      return;
    }

    const refreshPath = refreshPathRef.current;
    if (!refreshPath) {
      return;
    }

    const isMatchingList =
      pendingRequest?.mode === "list" && pendingRequest?.path === refreshPath;

    if (isMatchingList) {
      refreshStartedRef.current = true;
      return;
    }

    if (refreshStartedRef.current) {
      setIsRefreshing(false);
      refreshPathRef.current = null;
      refreshStartedRef.current = false;
    }
  }, [isRefreshing, pendingRequest?.mode, pendingRequest?.path]);

  const handleNavigateBack = useCallback(() => {
    if (!agentId || !navigateExplorerBack) {
      return;
    }

    if ((explorerState?.history?.length ?? 0) > 1) {
      navigateExplorerBack(agentId);
    }
  }, [agentId, explorerState?.history?.length, navigateExplorerBack]);

  const renderEntry = useCallback(
    ({ item }: ListRenderItemInfo<ExplorerEntry>) => {
      if (viewMode === "grid") {
        const preview = explorerState?.files.get(item.path);
        const isImage = getEntryDisplayKind(item) === "image";
        const isLoadingThumb = Boolean(thumbnailLoadingMap[item.path]);
        return (
          <Pressable
            style={styles.gridCard}
            onPress={() => handleEntryPress(item)}
          >
            <View
              style={[styles.gridThumbnail, isImage && styles.gridImageBackground]}
            >
              {isImage && preview?.content ? (
                <RNImage
                  source={{
                    uri: `data:${preview.mimeType ?? "image/png"};base64,${preview.content}`,
                  }}
                  style={styles.gridImage}
                  resizeMode="cover"
                />
              ) : isImage && isLoadingThumb ? (
                <ActivityIndicator size="small" />
              ) : (
                renderEntryIcon(getEntryDisplayKind(item), theme.colors)
              )}
            </View>
            <Text style={styles.gridName} numberOfLines={1}>
              {item.name}
            </Text>
            <Text style={styles.gridMeta} numberOfLines={1}>
              {formatFileSize({ size: item.size })}
            </Text>
          </Pressable>
        );
      }

      const displayKind = getEntryDisplayKind(item);
      return (
        <Pressable
          style={[styles.entryRow, styles.entryRowBackground]}
          onPress={() => handleEntryPress(item)}
        >
          <View style={styles.entryInfo}>
            <View style={styles.entryIcon}>
              {renderEntryIcon(displayKind, theme.colors)}
            </View>
            <Text style={styles.entryName} numberOfLines={1}>
              {item.name}
            </Text>
          </View>
          <Pressable
            onPress={(event) => handleOpenMenu(item, event)}
            hitSlop={8}
            style={styles.menuButton}
          >
            <MoreVertical size={16} color={theme.colors.foreground} />
          </Pressable>
        </Pressable>
      );
    },
    [
      explorerState?.files,
      handleEntryPress,
      handleOpenMenu,
      theme.colors,
      thumbnailLoadingMap,
      viewMode,
    ]
  );

  const handleSortCycle = useCallback(() => {
    const currentIndex = SORT_OPTIONS.findIndex((opt) => opt.value === sortOption);
    const nextIndex = (currentIndex + 1) % SORT_OPTIONS.length;
    setSortOption(SORT_OPTIONS[nextIndex].value);
  }, [sortOption, setSortOption]);

  const currentSortLabel = SORT_OPTIONS.find((opt) => opt.value === sortOption)?.label ?? "Name";

  const listHeaderComponent = useMemo(() => {
    const canGoBack = (explorerState?.history?.length ?? 0) > 1;
    return (
      <View style={styles.headerContainer}>
        <View style={styles.headerRow}>
          <View style={styles.pathContainer}>
            {canGoBack && (
              <Pressable onPress={handleNavigateBack} style={styles.backButton}>
                <Text style={styles.backButtonText}>←</Text>
              </Pressable>
            )}
            <Text style={styles.pathText} numberOfLines={1}>
              {formatDirectoryLabel(activePath)}
            </Text>
          </View>
          <Pressable style={styles.sortButton} onPress={handleSortCycle}>
            <Text style={styles.sortButtonText}>{currentSortLabel}</Text>
            <ChevronDown size={14} color={theme.colors.foregroundMuted} />
          </Pressable>
        </View>
      </View>
    );
  }, [activePath, currentSortLabel, explorerState?.history?.length, handleNavigateBack, handleSortCycle]);

  // Watch for completed file previews and process queue
  useEffect(() => {
    if (!explorerState) {
      return;
    }

    const completedPaths: string[] = [];
    for (const path of inFlightPathsRef.current) {
      if (explorerState.files.has(path)) {
        completedPaths.push(path);
      }
    }

    if (completedPaths.length === 0) {
      return;
    }

    for (const path of completedPaths) {
      inFlightPathsRef.current.delete(path);
    }

    setThumbnailLoadingMap((prev) => {
      const next = { ...prev };
      for (const path of completedPaths) {
        delete next[path];
      }
      return next;
    });

    queueMicrotask(() => {
      processNextThumbnail();
    });
  }, [explorerState?.files.size, processNextThumbnail]);

  // Clear queue and loading state on path/view change
  useEffect(() => {
    thumbnailQueueRef.current = [];
    inFlightPathsRef.current.clear();
    setThumbnailLoadingMap({});
  }, [activePath, viewMode]);

  if (!agentExists) {
    return (
      <View style={styles.centerState}>
        <Text style={styles.errorText}>Agent not found</Text>
      </View>
    );
  }

  return (
    <View style={styles.container} onLayout={handleContainerLayout}>
      <View style={styles.content}>
        <View style={styles.listSection}>
          {error ? (
            <View style={styles.centerState}>
              <Text style={styles.errorText}>{error}</Text>
              <View style={styles.errorActions}>
                <Pressable style={styles.retryButton} onPress={handleRetryDirectory}>
                  <Text style={styles.retryButtonText}>Retry</Text>
                </Pressable>
                {activePath !== "." && (
                  <Pressable
                    style={styles.goToWorkspaceButton}
                    onPress={() => requestDirectoryListing?.(agentId, ".")}
                  >
                    <Text style={styles.goToWorkspaceButtonText}>Go to workspace</Text>
                  </Pressable>
                )}
              </View>
            </View>
          ) : showInitialListLoading ? (
            <View style={styles.centerState}>
              <ActivityIndicator size="small" />
              <Text style={styles.loadingText}>Loading directory...</Text>
            </View>
          ) : entries.length === 0 ? (
            <View style={styles.centerState}>
              <Text style={styles.emptyText}>Directory is empty</Text>
            </View>
          ) : (
            <FlatList
              ref={listScrollRef}
              data={entries}
              renderItem={renderEntry}
              keyExtractor={(item) => item.path}
              contentContainerStyle={
                viewMode === "grid" ? styles.gridContent : styles.entriesContent
              }
              columnWrapperStyle={
                viewMode === "grid" && listColumns > 1
                  ? styles.gridColumnWrapper
                  : undefined
              }
              numColumns={listColumns}
              key={listKey}
              onScroll={handleListScroll}
              scrollEventThrottle={16}
              onLayout={restoreQueuedScrollOffset}
              onContentSizeChange={restoreQueuedScrollOffset}
              ListHeaderComponent={listHeaderComponent}
              extraData={{ viewMode, thumbnailLoadingMap }}
              initialNumToRender={20}
              maxToRenderPerBatch={30}
              windowSize={15}
              refreshControl={
                <RefreshControl refreshing={isRefreshing} onRefresh={handleRefresh} />
              }
              onViewableItemsChanged={handleViewableItemsChangedRef.current}
              viewabilityConfig={viewabilityConfigRef.current}
            />
          )}
        </View>
      </View>

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
                style={styles.entryMenuItem}
                onPress={() => {
                  handleCopyPath(menuEntry.path);
                  handleCloseMenu();
                }}
              >
                <Text style={styles.entryMenuText}>Copy Path</Text>
              </Pressable>
              {menuEntry.kind === "file" ? (
                <Pressable
                  style={styles.entryMenuItem}
                  onPress={async () => {
                    handleCloseMenu();
                    await handleDownloadEntry(menuEntry);
                  }}
                >
                  <Text style={styles.entryMenuText}>Download</Text>
                </Pressable>
              ) : null}
            </View>
          ) : null}
        </View>
      </Modal>

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
          <Pressable onPress={handleClosePreviewSheet} style={styles.sheetCloseButton}>
            <X size={20} color={theme.colors.foregroundMuted} />
          </Pressable>
        </View>
        {isPreviewLoading && !preview ? (
          <View style={styles.sheetCenterState}>
            <ActivityIndicator size="small" />
            <Text style={styles.loadingText}>Loading file...</Text>
          </View>
        ) : !preview ? (
          <View style={styles.sheetCenterState}>
            <Text style={styles.emptyText}>No preview available yet</Text>
          </View>
        ) : preview.kind === "text" ? (
          <BottomSheetScrollView
            style={styles.sheetContent}
            contentContainerStyle={styles.sheetScrollContent}
          >
            <ScrollView horizontal nestedScrollEnabled showsHorizontalScrollIndicator>
              <Text style={styles.codeText}>{preview.content}</Text>
            </ScrollView>
          </BottomSheetScrollView>
        ) : preview.kind === "image" && preview.content ? (
          <BottomSheetScrollView
            contentContainerStyle={styles.sheetImageScrollContent}
          >
            <RNImage
              source={{
                uri: `data:${preview.mimeType ?? "image/png"};base64,${preview.content}`,
              }}
              style={styles.sheetImage}
              resizeMode="contain"
            />
          </BottomSheetScrollView>
        ) : (
          <View style={styles.sheetCenterState}>
            <Text style={styles.emptyText}>Binary preview unavailable</Text>
            <Text style={styles.entryMenuMeta}>
              {formatFileSize({ size: preview.size })}
            </Text>
          </View>
        )}
      </BottomSheetModal>
    </View>
  );
}

function formatDirectoryLabel(path: string): string {
  return path === "." ? "workspace root" : path;
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
  colors: { foreground: string; primary: string }
) {
  const color = colors.foreground;
  switch (kind) {
    case "directory":
      return <Folder size={18} color={colors.primary} />;
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

const styles = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
    backgroundColor: theme.colors.surface0,
  },
  content: {
    flex: 1,
    flexDirection: "column",
    paddingHorizontal: theme.spacing[3],
    paddingBottom: theme.spacing[3],
    gap: theme.spacing[3],
  },
  listSection: {
    flex: 1,
  },
  entriesContent: {
    paddingBottom: theme.spacing[4],
  },
  headerContainer: {
    gap: theme.spacing[2],
    paddingBottom: theme.spacing[2],
  },
  headerRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  pathContainer: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    marginRight: theme.spacing[2],
  },
  pathText: {
    flex: 1,
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
    fontFamily: Fonts.mono,
  },
  backButton: {
    padding: theme.spacing[1],
  },
  backButtonText: {
    fontSize: theme.fontSize.lg,
    color: theme.colors.foreground,
  },
  sortButton: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    paddingVertical: theme.spacing[1],
    paddingHorizontal: theme.spacing[2],
    borderRadius: theme.borderRadius.md,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface2,
  },
  sortButtonText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
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
  errorActions: {
    flexDirection: "row",
    gap: theme.spacing[2],
  },
  retryButton: {
    borderRadius: theme.borderRadius.full,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.primary,
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[1],
  },
  retryButtonText: {
    color: theme.colors.primary,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.semibold,
  },
  goToWorkspaceButton: {
    borderRadius: theme.borderRadius.full,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[1],
  },
  goToWorkspaceButtonText: {
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
    paddingLeft: theme.spacing[2],
    borderRadius: theme.borderRadius.md,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    marginBottom: theme.spacing[1],
  },
  entryRowBackground: {
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
  menuOverlay: {
    flex: 1,
  },
  menuBackdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "rgba(0, 0, 0, 0.2)",
  },
  entryMenu: {
    borderRadius: theme.borderRadius.md,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface2,
    padding: theme.spacing[1],
  },
  entryMenuHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    paddingVertical: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
  },
  entryMenuMeta: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
  },
  entryMenuDivider: {
    height: 1,
    backgroundColor: theme.colors.border,
    marginHorizontal: theme.spacing[2],
    marginVertical: theme.spacing[1],
  },
  entryMenuItem: {
    paddingVertical: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    borderRadius: theme.borderRadius.md,
  },
  entryMenuText: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.semibold,
  },
  codeText: {
    color: theme.colors.foreground,
    fontFamily: Fonts.mono,
    fontSize: theme.fontSize.sm,
    flexShrink: 0,
  },
  gridContent: {
    paddingBottom: theme.spacing[4],
    paddingHorizontal: theme.spacing[1],
  },
  gridColumnWrapper: {
    justifyContent: "space-between",
    marginBottom: theme.spacing[2],
  },
  gridCard: {
    flex: 1,
    borderRadius: theme.borderRadius.lg,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    padding: theme.spacing[2],
    gap: theme.spacing[2],
    backgroundColor: theme.colors.surface2,
    marginHorizontal: theme.spacing[1],
    marginBottom: theme.spacing[1],
    minWidth: 0,
  },
  gridThumbnail: {
    width: "100%",
    aspectRatio: 1,
    borderRadius: theme.borderRadius.md,
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
    backgroundColor: theme.colors.surface2,
  },
  gridImageBackground: {
    backgroundColor: theme.colors.surface0,
  },
  gridImage: {
    width: "100%",
    height: "100%",
  },
  gridName: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
  },
  gridMeta: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
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
  sheetContent: {
    flex: 1,
  },
  sheetScrollContent: {
    padding: theme.spacing[4],
  },
  sheetCenterState: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: theme.spacing[2],
    padding: theme.spacing[4],
  },
  sheetImageScrollContent: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: theme.spacing[4],
  },
  sheetImage: {
    width: "100%",
    aspectRatio: 1,
  },
}));
