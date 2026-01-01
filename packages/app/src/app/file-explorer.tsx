import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Image as RNImage,
  LayoutChangeEvent,
  ListRenderItemInfo,
  ViewToken,
  NativeScrollEvent,
  NativeSyntheticEvent,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  Text,
  View,
  BackHandler,
  useWindowDimensions,
} from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { router, useFocusEffect, useLocalSearchParams } from "expo-router";
import * as Clipboard from "expo-clipboard";
import * as FileSystem from "expo-file-system";
import * as Sharing from "expo-sharing";
import {
  File,
  FileText,
  Folder,
  Image as ImageIcon,
  LayoutGrid,
  List as ListIcon,
  MoreVertical,
  X,
} from "lucide-react-native";
import { BackHeader } from "@/components/headers/back-header";
import type { ExplorerEntry } from "@/stores/session-store";
import type { ConnectionStatus } from "@/contexts/daemon-connections-context";
import { useDaemonConnections } from "@/contexts/daemon-connections-context";
import type { DaemonProfile } from "@/contexts/daemon-registry-context";
import { formatConnectionStatus } from "@/utils/daemons";
import { useSessionStore } from "@/stores/session-store";

export default function FileExplorerScreen() {
  const {
    agentId,
    path: pathParamRaw,
    file: fileParamRaw,
    serverId,
  } = useLocalSearchParams<{
    agentId: string;
    path?: string | string[];
    file?: string | string[];
    serverId?: string;
  }>();
  const resolvedServerId = typeof serverId === "string" ? serverId : undefined;
  const { connectionStates } = useDaemonConnections();

  const session = useSessionStore((state) =>
    resolvedServerId ? state.sessions[resolvedServerId] : undefined
  );

  const connectionServerId = resolvedServerId ?? null;
  const connection = connectionServerId ? connectionStates.get(connectionServerId) : null;
  const serverLabel = connection?.daemon.label ?? connectionServerId ?? resolvedServerId ?? "Selected host";
  const connectionStatus = connection?.status ?? "idle";
  const connectionStatusLabel = formatConnectionStatus(connectionStatus);
  const lastError = connection?.lastError ?? null;

  if (!session) {
    return (
      <FileExplorerSessionUnavailable
        agentId={agentId}
        serverId={resolvedServerId}
        serverLabel={serverLabel}
        connectionStatus={connectionStatus}
        connectionStatusLabel={connectionStatusLabel}
        lastError={lastError}
      />
    );
  }

  const routeServerId = resolvedServerId ?? session.serverId;

  return (
    <FileExplorerContent
      serverId={routeServerId}
      agentId={agentId}
      pathParamRaw={pathParamRaw}
      fileParamRaw={fileParamRaw}
    />
  );
}

type FileExplorerContentProps = {
  serverId: string;
  agentId?: string;
  pathParamRaw?: string | string[];
  fileParamRaw?: string | string[];
};

type FileExplorerSessionUnavailableProps = {
  agentId?: string;
  serverId?: string;
  serverLabel: string;
  connectionStatus: ConnectionStatus;
  connectionStatusLabel: string;
  lastError: string | null;
};

function FileExplorerContent({
  serverId,
  agentId,
  pathParamRaw,
  fileParamRaw,
}: FileExplorerContentProps) {
  const { theme } = useUnistyles();
  const { connectionStates } = useDaemonConnections();
  const daemonProfile = connectionStates.get(serverId)?.daemon;

  const agent = useSessionStore((state) =>
    agentId && state.sessions[serverId]
      ? state.sessions[serverId]?.agents.get(agentId)
      : undefined
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
  const [viewMode, setViewMode] = useState<"list" | "grid">("list");
  const [selectedEntryPath, setSelectedEntryPath] = useState<string | null>(null);
  const pendingPathParamRef = useRef<string | null>(null);
  const pendingFileParamRef = useRef<string | null>(null);
  const listScrollRef = useRef<FlatList<ExplorerEntry> | null>(null);
  const listScrollOffsetRef = useRef(0);
  const scrollOffsetsByPathRef = useRef<Map<string, number>>(new Map());
  const pendingScrollRestoreRef = useRef<number | null>(null);
  const { width: windowWidth, height: windowHeight } = useWindowDimensions();

  const normalizedPathParam = normalizePathParam(getFirstParam(pathParamRaw));
  const normalizedFileParam = normalizeFileParam(getFirstParam(fileParamRaw));
  const derivedDirectoryFromFile = normalizedFileParam
    ? deriveDirectoryFromFile(normalizedFileParam)
    : null;
  const history = explorerState?.history ?? [];
  const lastKnownDirectory = history[history.length - 1];
  const rememberedDirectory = explorerState?.lastVisitedPath;
  const initialTargetDirectory =
    normalizedPathParam ??
    derivedDirectoryFromFile ??
    rememberedDirectory ??
    lastKnownDirectory ??
    ".";
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
  const entries = directory?.entries ?? [];
  const showInitialListLoading = isListingLoading && entries.length === 0;
  const showListLoadingBanner = isListingLoading && entries.length > 0;
  const isPreviewLoading = Boolean(
    isExplorerLoading && pendingRequest?.mode === "file"
  );
  const error = explorerState?.lastError ?? null;
  const preview = selectedEntryPath
    ? explorerState?.files.get(selectedEntryPath)
    : null;
  const shouldShowPreview = Boolean(selectedEntryPath);
  const pendingThumbnailPathsRef = useRef<Set<string>>(new Set());
  const [thumbnailLoadingMap, setThumbnailLoadingMap] = useState<Record<string, boolean>>({});
  const viewabilityConfigRef = useRef({ itemVisiblePercentThreshold: 50 });
  const gridColumnCount = useMemo(() => {
    if (windowWidth >= 1500) {
      return 6;
    }
    if (windowWidth >= 1200) {
      return 5;
    }
    if (windowWidth >= 960) {
      return 4;
    }
    if (windowWidth >= 720) {
      return 3;
    }
    if (windowWidth >= 520) {
      return 2;
    }
    return 1;
  }, [windowWidth]);
  const listColumns = viewMode === "grid" ? gridColumnCount : 1;
  const listKey = viewMode === "grid" ? `grid-${gridColumnCount}` : "list";
  const [menuEntry, setMenuEntry] = useState<ExplorerEntry | null>(null);
  const [menuAnchor, setMenuAnchor] = useState({ top: 0, left: 0 });
  const [menuHeight, setMenuHeight] = useState(0);
  const agentIdRef = useRef(agentId);
  const viewModeRef = useRef(viewMode);
  const requestFilePreviewRef = useRef(requestFilePreview);
  const explorerFilesRef = useRef(explorerState?.files);

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

  const handleViewableItemsChangedRef = useRef(
    ({ viewableItems }: { viewableItems: Array<ViewToken> }) => {
      const currentAgentId = agentIdRef.current;
      const currentViewMode = viewModeRef.current;
      const currentRequestFilePreview = requestFilePreviewRef.current;
      if (!currentAgentId || currentViewMode !== "grid" || !currentRequestFilePreview) {
        return;
      }

      viewableItems.forEach((token) => {
        const item = token.item as ExplorerEntry | undefined;
        if (!item) {
          return;
        }

        if (getEntryDisplayKind(item) !== "image") {
          return;
        }

        const hasPreview = explorerFilesRef.current?.get(item.path);
        if (hasPreview || pendingThumbnailPathsRef.current.has(item.path)) {
          return;
        }

        pendingThumbnailPathsRef.current.add(item.path);
        setThumbnailLoadingMap((prev) => ({ ...prev, [item.path]: true }));
        currentRequestFilePreview(currentAgentId, item.path);
      });
    }
  );

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

  useEffect(() => {
    if (!agentId || !initialTargetDirectory || !requestDirectoryListing) {
      pendingPathParamRef.current = null;
      return;
    }

    if (pendingPathParamRef.current === initialTargetDirectory) {
      return;
    }

    pendingPathParamRef.current = initialTargetDirectory;
    requestDirectoryListing(agentId, initialTargetDirectory);
  }, [agentId, initialTargetDirectory, requestDirectoryListing]);

  useEffect(() => {
    if (!agentId || !normalizedFileParam || !requestFilePreview) {
      pendingFileParamRef.current = null;
      return;
    }

    pendingFileParamRef.current = normalizedFileParam;
    requestFilePreview(agentId, normalizedFileParam);
  }, [agentId, normalizedFileParam, requestFilePreview]);

  useEffect(() => {
    if (!agentId) {
      return;
    }

    const targetFile = pendingFileParamRef.current;
    if (!targetFile) {
      return;
    }

    const hasEntry = entries.some((entry) => entry.path === targetFile);
    if (!hasEntry) {
      return;
    }

    setSelectedEntryPath(targetFile);
    pendingFileParamRef.current = null;
  }, [agentId, entries]);

  const handleEntryPress = useCallback(
    (entry: ExplorerEntry) => {
      if (!agentId || !requestDirectoryListing || !requestFilePreview) {
        return;
      }

      if (entry.kind === "directory") {
        setSelectedEntryPath(null);
        requestDirectoryListing(agentId, entry.path);
        return;
      }

      setSelectedEntryPath(entry.path);
      requestFilePreview(agentId, entry.path);
    },
    [agentId, requestDirectoryListing, requestFilePreview]
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
    async (entry: ExplorerEntry) => {
      if (!agentId || !requestFileDownloadToken || entry.kind !== "file") {
        return;
      }

      try {
        const tokenResponse = await requestFileDownloadToken(agentId, entry.path);
        if (tokenResponse.error || !tokenResponse.token) {
          throw new Error(tokenResponse.error ?? "Failed to request download token.");
        }

        const downloadTarget = resolveDaemonDownloadTarget(daemonProfile);
        if (!downloadTarget.baseUrl) {
          throw new Error("Download host is unavailable.");
        }

        const fileName = tokenResponse.fileName ?? entry.name;
        const downloadUrl = buildDownloadUrl(
          downloadTarget.baseUrl,
          tokenResponse.token,
          Platform.OS === "web" ? downloadTarget.authCredentials : null
        );

        if (Platform.OS === "web") {
          triggerBrowserDownload(downloadUrl, fileName);
          return;
        }

        const targetUri = await resolveDownloadTargetUri(fileName);
        const downloadResult = await FileSystem.downloadAsync(
          downloadUrl,
          targetUri,
          downloadTarget.authHeader
            ? { headers: { Authorization: downloadTarget.authHeader } }
            : undefined
        );
        if (await Sharing.isAvailableAsync()) {
          await Sharing.shareAsync(downloadResult.uri, {
            mimeType: tokenResponse.mimeType ?? undefined,
            dialogTitle: fileName ? `Share ${fileName}` : "Share file",
          });
        } else {
          Alert.alert("Download complete", `Saved to ${downloadResult.uri}`);
        }
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Failed to download file.";
        if (Platform.OS === "web") {
          console.warn("[FileExplorer] Download failed:", message);
          return;
        }
        Alert.alert("Download failed", message);
      }
    },
    [agentId, daemonProfile, requestFileDownloadToken]
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

  const handleCloseExplorer = useCallback(() => {
    if (agentId) {
      router.replace({
        pathname: "/agent/[serverId]/[agentId]",
        params: { serverId, agentId },
      });
      return;
    }

    router.back();
  }, [agentId, serverId]);

  const handleRetryDirectory = useCallback(() => {
    if (!agentId || !requestDirectoryListing) {
      return;
    }
    requestDirectoryListing(agentId, activePath);
  }, [agentId, requestDirectoryListing, activePath]);

  const handleBackNavigation = useCallback(() => {
    if (!agentId) {
      router.back();
      return true;
    }

    if (shouldShowPreview) {
      setSelectedEntryPath(null);
      return true;
    }

    if ((explorerState?.history?.length ?? 0) > 1 && navigateExplorerBack) {
      navigateExplorerBack(agentId);
      return true;
    }

    handleCloseExplorer();
    return true;
  }, [agentId, explorerState?.history?.length, handleCloseExplorer, navigateExplorerBack, shouldShowPreview]);

  useFocusEffect(
    useCallback(() => {
      const subscription = BackHandler.addEventListener("hardwareBackPress", handleBackNavigation);
      return () => subscription.remove();
    }, [handleBackNavigation])
  );

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
            <Text style={styles.gridName} numberOfLines={2}>
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
          style={[
            styles.entryRow,
            item.kind === "directory" ? styles.directoryRow : styles.fileRow,
          ]}
          onPress={() => handleEntryPress(item)}
        >
          <View style={styles.entryInfo}>
            <View style={styles.entryIcon}>
              {renderEntryIcon(displayKind, theme.colors)}
            </View>
            <View style={styles.entryTextContainer}>
              <Text style={styles.entryName}>{item.name}</Text>
              <Text style={styles.entryMeta}>
                {item.kind.toUpperCase()} · {formatFileSize({ size: item.size })} ·{" "}
                {formatModifiedTime({ value: item.modifiedAt })}
              </Text>
            </View>
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

  const listHeaderComponent = useMemo(() => {
    return (
      <View style={styles.headerContainer}>
        <View style={styles.headerRow}>
          <ViewToggle viewMode={viewMode} onChange={setViewMode} />
        </View>
        {showListLoadingBanner && (
          <View style={styles.loadingBanner}>
            <ActivityIndicator size="small" />
            <Text style={styles.loadingBannerText}>
              Loading {formatDirectoryLabel(activePath)}...
            </Text>
          </View>
        )}
      </View>
    );
  }, [activePath, showListLoadingBanner, viewMode]);

  useEffect(() => {
    if (!explorerState) {
      return;
    }
    setThumbnailLoadingMap((prev) => {
      let changed = false;
      const next = { ...prev };
      Object.keys(prev).forEach((path) => {
        if (explorerState.files.has(path)) {
          delete next[path];
          pendingThumbnailPathsRef.current.delete(path);
          changed = true;
        }
      });
      return changed ? next : prev;
    });
  }, [explorerState?.files.size]);

  useEffect(() => {
    pendingThumbnailPathsRef.current.clear();
    setThumbnailLoadingMap({});
  }, [activePath, viewMode]);

  if (!agent) {
    return (
      <View style={styles.container}>
        <BackHeader
          title="Files"
          onBack={handleBackNavigation}
          rightContent={
            <Pressable style={styles.closeButton} onPress={handleCloseExplorer}>
              <X size={18} color={theme.colors.foreground} />
            </Pressable>
          }
        />
        <View style={styles.centerState}>
          <Text style={styles.errorText}>Agent not found</Text>
        </View>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <BackHeader
        title={selectedEntryPath ?? (activePath || ".")}
        onBack={handleBackNavigation}
        rightContent={
          <Pressable style={styles.closeButton} onPress={handleCloseExplorer}>
            <X size={18} color={theme.colors.foreground} />
          </Pressable>
        }
      />

      <View style={styles.content}>
        {shouldShowPreview ? (
          <View style={styles.previewWrapper}>
            <View style={styles.previewSection}>
              {isPreviewLoading && !preview ? (
                <View style={styles.centerState}>
                  <ActivityIndicator size="small" />
                  <Text style={styles.loadingText}>Loading file...</Text>
                </View>
              ) : !preview ? (
                <View style={styles.centerState}>
                  <Text style={styles.emptyText}>No preview available yet</Text>
                </View>
              ) : preview.kind === "text" ? (
                <ScrollView
                  style={styles.textPreview}
                  horizontal={false}
                  contentContainerStyle={styles.textPreviewContent}
                >
                  <ScrollView horizontal>
                    <Text style={styles.codeText}>{preview.content}</Text>
                  </ScrollView>
                </ScrollView>
              ) : preview.kind === "image" && preview.content ? (
                <View style={styles.imagePreviewContainer}>
                  <RNImage
                    source={{
                      uri: `data:${preview.mimeType ?? "image/png"};base64,${
                        preview.content
                      }`,
                    }}
                    style={styles.image}
                    resizeMode="contain"
                  />
                </View>
              ) : (
                <View style={styles.centerState}>
                  <Text style={styles.emptyText}>Binary preview unavailable</Text>
                  <Text style={styles.entryMeta}>
                    {formatFileSize({ size: preview.size })}
                  </Text>
                </View>
              )}
            </View>
          </View>
        ) : (
          <View style={styles.listSection}>
            {error ? (
              <View style={styles.centerState}>
                <Text style={styles.errorText}>{error}</Text>
                <Pressable style={styles.retryButton} onPress={handleRetryDirectory}>
                  <Text style={styles.retryButtonText}>Retry</Text>
                </Pressable>
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
                windowSize={10}
                onViewableItemsChanged={handleViewableItemsChangedRef.current}
                viewabilityConfig={viewabilityConfigRef.current}
              />
            )}
          </View>
        )}
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
    </View>
  );
}

function FileExplorerSessionUnavailable({
  agentId,
  serverId,
  serverLabel,
  connectionStatus,
  connectionStatusLabel,
  lastError,
}: FileExplorerSessionUnavailableProps) {
  const { theme } = useUnistyles();

  const handleClose = useCallback(() => {
    if (agentId && serverId) {
      router.replace({
        pathname: "/agent/[serverId]/[agentId]",
        params: { serverId, agentId },
      });
      return;
    }
    router.back();
  }, [agentId, serverId]);

  const isConnecting = connectionStatus === "connecting";

  return (
    <View style={styles.container}>
      <BackHeader
        title="Files"
        onBack={handleClose}
        rightContent={
          <Pressable style={styles.closeButton} onPress={handleClose}>
            <X size={18} color={theme.colors.foreground} />
          </Pressable>
        }
      />
      <View style={styles.centerState}>
        {isConnecting ? (
          <>
            <ActivityIndicator size="small" />
            <Text style={styles.loadingText}>Connecting to {serverLabel}...</Text>
            <Text style={styles.statusText}>We will load files once this host is online.</Text>
          </>
        ) : (
          <>
            <Text style={styles.offlineTitle}>
              {serverLabel} is currently {connectionStatusLabel.toLowerCase()}.
            </Text>
            <Text style={styles.offlineDescription}>
              We'll reconnect automatically and load files once the host is back online. No action needed.
            </Text>
            {lastError ? <Text style={styles.offlineDetails}>{lastError}</Text> : null}
          </>
        )}
      </View>
    </View>
  );
}

function ViewToggle({
  viewMode,
  onChange,
}: {
  viewMode: "list" | "grid";
  onChange: (mode: "list" | "grid") => void;
}) {
  const { theme } = useUnistyles();

  return (
    <View style={styles.viewToggleContainer}>
      <Pressable
        style={[styles.viewToggleButton, viewMode === "list" && styles.viewToggleActive]}
        onPress={() => onChange("list")}
      >
        <ListIcon size={16} color={theme.colors.foreground} />
        <Text style={styles.viewToggleText}>List</Text>
      </Pressable>
      <Pressable
        style={[styles.viewToggleButton, viewMode === "grid" && styles.viewToggleActive]}
        onPress={() => onChange("grid")}
      >
        <LayoutGrid size={16} color={theme.colors.foreground} />
        <Text style={styles.viewToggleText}>Gallery</Text>
      </Pressable>
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

function formatModifiedTime({ value }: { value: string }): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return date.toLocaleString();
}

function getFirstParam(value?: string | string[]): string | null {
  if (Array.isArray(value)) {
    return value[0] ?? null;
  }
  return value ?? null;
}

function normalizePathParam(value: string | null): string | null {
  if (value === null) {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed.length) {
    return ".";
  }
  return trimmed.replace(/\\/g, "/");
}

function normalizeFileParam(value: string | null): string | null {
  if (value === null) {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed.length) {
    return null;
  }
  return trimmed.replace(/\\/g, "/");
}

function deriveDirectoryFromFile(filePath: string): string {
  const normalized = filePath.replace(/\\/g, "/");
  const lastSlash = normalized.lastIndexOf("/");
  if (lastSlash === -1) {
    return ".";
  }
  const directory = normalized.slice(0, lastSlash);
  return directory.length > 0 ? directory : ".";
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

type DownloadTarget = {
  baseUrl: string | null;
  authHeader: string | null;
  authCredentials: { username: string; password: string } | null;
};

function resolveDaemonDownloadTarget(daemon?: DaemonProfile): DownloadTarget {
  const rawUrl = daemon?.restUrl ?? daemon?.wsUrl;
  if (!rawUrl) {
    return { baseUrl: null, authHeader: null, authCredentials: null };
  }

  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { baseUrl: null, authHeader: null, authCredentials: null };
  }

  if (parsed.protocol === "ws:") {
    parsed.protocol = "http:";
  } else if (parsed.protocol === "wss:") {
    parsed.protocol = "https:";
  }

  let authCredentials: { username: string; password: string } | null = null;
  if (parsed.username || parsed.password) {
    authCredentials = {
      username: decodeURIComponent(parsed.username),
      password: decodeURIComponent(parsed.password),
    };
    parsed.username = "";
    parsed.password = "";
  }

  parsed.pathname = parsed.pathname.replace(/\/ws\/?$/, "/");

  const baseUrl = parsed.origin;
  const authHeader = authCredentials
    ? `Basic ${btoa(`${authCredentials.username}:${authCredentials.password}`)}`
    : null;

  return { baseUrl, authHeader, authCredentials };
}

function buildDownloadUrl(
  baseUrl: string,
  token: string,
  authCredentials: { username: string; password: string } | null
): string {
  const url = new URL("/api/files/download", baseUrl);
  url.searchParams.set("token", token);
  if (authCredentials) {
    url.username = authCredentials.username;
    url.password = authCredentials.password;
  }
  return url.toString();
}

function triggerBrowserDownload(url: string, fileName: string) {
  if (typeof document === "undefined") {
    if (typeof window !== "undefined") {
      window.open(url, "_blank", "noopener");
    }
    return;
  }

  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  link.rel = "noopener";
  document.body.appendChild(link);
  link.click();
  link.remove();
}

async function resolveDownloadTargetUri(fileName: string): Promise<string> {
  const directory = FileSystem.Paths.cache?.uri ?? FileSystem.Paths.document?.uri;
  if (!directory) {
    throw new Error("No download directory available.");
  }

  const safeName = sanitizeDownloadFileName(fileName);
  const split = splitFileName(safeName);
  let targetUri = `${directory}${safeName}`;
  let suffix = 1;

  while ((await FileSystem.getInfoAsync(targetUri)).exists) {
    targetUri = `${directory}${split.base} (${suffix})${split.ext}`;
    suffix += 1;
  }

  return targetUri;
}

function sanitizeDownloadFileName(fileName: string): string {
  const trimmed = fileName.trim();
  if (!trimmed) {
    return "download";
  }
  return trimmed.replace(/[\\/:*?"<>|]+/g, "_");
}

function splitFileName(fileName: string): { base: string; ext: string } {
  const lastDot = fileName.lastIndexOf(".");
  if (lastDot <= 0) {
    return { base: fileName, ext: "" };
  }
  return {
    base: fileName.slice(0, lastDot),
    ext: fileName.slice(lastDot),
  };
}

const styles = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
    backgroundColor: theme.colors.background,
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
    justifyContent: "flex-end",
  },
  loadingBanner: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingVertical: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
  },
  loadingBannerText: {
    color: theme.colors.mutedForeground,
    fontSize: theme.fontSize.sm,
  },
  previewWrapper: {
    flex: 1,
    gap: theme.spacing[2],
  },
  previewSection: {
    flex: 1,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.lg,
    padding: theme.spacing[2],
  },
  centerState: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: theme.spacing[2],
    padding: theme.spacing[4],
  },
  loadingText: {
    color: theme.colors.mutedForeground,
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
    borderColor: theme.colors.primary,
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[1],
  },
  retryButtonText: {
    color: theme.colors.primary,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.semibold,
  },
  statusText: {
    color: theme.colors.mutedForeground,
    fontSize: theme.fontSize.sm,
    textAlign: "center",
  },
  errorDetails: {
    color: theme.colors.mutedForeground,
    fontSize: theme.fontSize.xs,
    textAlign: "center",
  },
  offlineTitle: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.semibold,
    textAlign: "center",
  },
  offlineDescription: {
    color: theme.colors.mutedForeground,
    fontSize: theme.fontSize.sm,
    textAlign: "center",
  },
  offlineDetails: {
    color: theme.colors.mutedForeground,
    fontSize: theme.fontSize.xs,
    textAlign: "center",
  },
  emptyText: {
    color: theme.colors.mutedForeground,
    fontSize: theme.fontSize.base,
    textAlign: "center",
  },
  entryRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingVertical: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    borderRadius: theme.borderRadius.md,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    marginBottom: theme.spacing[1],
  },
  directoryRow: {
    backgroundColor: theme.colors.muted,
  },
  fileRow: {
    backgroundColor: theme.colors.card,
  },
  selectedRow: {
    borderColor: theme.colors.primary,
  },
  entryInfo: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    columnGap: theme.spacing[2],
    marginRight: theme.spacing[3],
  },
  entryIcon: {
    width: 28,
    alignItems: "center",
  },
  entryTextContainer: {
    flex: 1,
  },
  entryName: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.semibold,
  },
  entryMeta: {
    color: theme.colors.mutedForeground,
    fontSize: theme.fontSize.xs,
    marginTop: theme.spacing[1],
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
    backgroundColor: theme.colors.card,
    padding: theme.spacing[1],
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
  viewToggleContainer: {
    flexDirection: "row",
    borderRadius: theme.borderRadius.full,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    overflow: "hidden",
  },
  viewToggleButton: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[1],
  },
  viewToggleActive: {
    backgroundColor: theme.colors.muted,
  },
  viewToggleText: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.semibold,
  },
  closeButton: {
    padding: theme.spacing[3],
    borderRadius: theme.borderRadius.lg,
  },
  textPreview: {
    flex: 1,
  },
  textPreviewContent: {
    padding: theme.spacing[2],
  },
  codeText: {
    color: theme.colors.foreground,
    fontFamily: "monospace",
    fontSize: theme.fontSize.sm,
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
    backgroundColor: theme.colors.card,
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
    backgroundColor: theme.colors.muted,
  },
  gridImageBackground: {
    backgroundColor: theme.colors.background,
  },
  gridImage: {
    width: "100%",
    height: "100%",
  },
  gridName: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.semibold,
  },
  gridMeta: {
    color: theme.colors.mutedForeground,
    fontSize: theme.fontSize.xs,
  },
  imagePreviewContainer: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  image: {
    width: "100%",
    height: "100%",
  },
}));
