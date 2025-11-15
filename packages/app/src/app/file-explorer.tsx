import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  Image as RNImage,
  ListRenderItemInfo,
  NativeScrollEvent,
  NativeSyntheticEvent,
  Pressable,
  ScrollView,
  Text,
  View,
} from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { useLocalSearchParams } from "expo-router";
import * as Clipboard from "expo-clipboard";
import {
  Copy,
  Check,
  ArrowLeft,
  File,
  FileText,
  Folder,
  Image as ImageIcon,
} from "lucide-react-native";
import { BackHeader } from "@/components/headers/back-header";
import { useSession, type ExplorerEntry } from "@/contexts/session-context";

export default function FileExplorerScreen() {
  const { theme } = useUnistyles();
  const {
    agentId,
    path: pathParamRaw,
    file: fileParamRaw,
  } = useLocalSearchParams<{
    agentId: string;
    path?: string | string[];
    file?: string | string[];
  }>();
  const {
    agents,
    fileExplorer,
    requestDirectoryListing,
    requestFilePreview,
  } = useSession();
  const [selectedEntryPath, setSelectedEntryPath] = useState<string | null>(null);
  const pendingPathParamRef = useRef<string | null>(null);
  const pendingFileParamRef = useRef<string | null>(null);
  const [copiedPath, setCopiedPath] = useState<string | null>(null);
  const copyTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const listScrollRef = useRef<FlatList<ExplorerEntry> | null>(null);
  const listScrollOffsetRef = useRef(0);

  const normalizedPathParam = normalizePathParam(getFirstParam(pathParamRaw));
  const normalizedFileParam = normalizeFileParam(getFirstParam(fileParamRaw));
  const derivedDirectoryFromFile = normalizedFileParam
    ? deriveDirectoryFromFile(normalizedFileParam)
    : null;
  const initialTargetDirectory = normalizedPathParam ?? derivedDirectoryFromFile ?? ".";

  const agent = agentId ? agents.get(agentId) : undefined;
  const explorerState = agentId ? fileExplorer.get(agentId) : undefined;
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

  useEffect(() => {
    setSelectedEntryPath(null);
  }, [activePath]);

  useEffect(() => {
    if (shouldShowPreview) {
      return;
    }

    const targetOffset = listScrollOffsetRef.current;
    if (!listScrollRef.current) {
      return;
    }

    listScrollRef.current.scrollToOffset({ offset: targetOffset, animated: false });
  }, [shouldShowPreview]);

  useEffect(() => {
    listScrollOffsetRef.current = 0;
    listScrollRef.current?.scrollToOffset({ offset: 0, animated: false });
  }, [activePath]);

  const parentPath = useMemo(() => {
    if (activePath === ".") {
      return null;
    }
    const segments = activePath.split("/");
    segments.pop();
    const nextPath = segments.join("/");
    return nextPath.length === 0 ? "." : nextPath;
  }, [activePath]);

  useEffect(() => {
    setCopiedPath(null);
  }, [activePath]);

  useEffect(() => {
    if (!agentId || !initialTargetDirectory) {
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
    if (!agentId || !normalizedFileParam) {
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
      if (!agentId) {
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

  const handleNavigateUp = useCallback(() => {
    if (!agentId || !parentPath) {
      return;
    }
    setSelectedEntryPath(null);
    requestDirectoryListing(agentId, parentPath);
  }, [agentId, parentPath, requestDirectoryListing]);

  const handleCopyPath = useCallback(async (path: string) => {
    await Clipboard.setStringAsync(path);
    setCopiedPath(path);
    if (copyTimeoutRef.current) {
      clearTimeout(copyTimeoutRef.current);
    }
    copyTimeoutRef.current = setTimeout(() => {
      setCopiedPath(null);
      copyTimeoutRef.current = null;
    }, 1500);
  }, []);

  useEffect(() => {
    return () => {
      if (copyTimeoutRef.current) {
        clearTimeout(copyTimeoutRef.current);
      }
    };
  }, []);

  const handleListScroll = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      listScrollOffsetRef.current = event.nativeEvent.contentOffset.y;
    },
    []
  );

  const renderEntry = useCallback(
    ({ item }: ListRenderItemInfo<ExplorerEntry>) => {
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
            onPress={(event) => {
              event.stopPropagation();
              handleCopyPath(item.path);
            }}
            hitSlop={8}
            style={styles.copyButton}
          >
            {copiedPath === item.path ? (
              <Check size={16} color={theme.colors.primary} />
            ) : (
              <Copy size={16} color={theme.colors.foreground} />
            )}
          </Pressable>
        </Pressable>
      );
    },
    [copiedPath, handleCopyPath, handleEntryPress, theme.colors]
  );

  const listHeaderComponent = useMemo(() => {
    if (!parentPath && !showListLoadingBanner) {
      return null;
    }

    return (
      <View style={styles.headerContainer}>
        {parentPath && <UpRow label=".." onPress={handleNavigateUp} />}
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
  }, [activePath, handleNavigateUp, parentPath, showListLoadingBanner]);

  if (!agent) {
    return (
      <View style={styles.container}>
        <BackHeader title="Files" />
        <View style={styles.centerState}>
          <Text style={styles.errorText}>Agent not found</Text>
        </View>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <BackHeader title={selectedEntryPath ?? (activePath || ".")} />

      <View style={styles.content}>
        {shouldShowPreview ? (
          <View style={styles.previewWrapper}>
            <UpRow label="Back to directory" onPress={() => setSelectedEntryPath(null)} />
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
                contentContainerStyle={styles.entriesContent}
                onScroll={handleListScroll}
                scrollEventThrottle={16}
                ListHeaderComponent={listHeaderComponent}
                extraData={copiedPath}
                initialNumToRender={20}
                maxToRenderPerBatch={30}
                windowSize={10}
              />
            )}
          </View>
        )}
      </View>
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

function UpRow({ label, onPress }: { label: string; onPress: () => void }) {
  const { theme } = useUnistyles();
  return (
    <Pressable style={styles.upRow} onPress={onPress}>
      <ArrowLeft size={16} color={theme.colors.foreground} />
      <Text style={styles.upRowText}>{label}</Text>
    </Pressable>
  );
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
  copyButton: {
    width: 36,
    height: 36,
    borderRadius: theme.borderRadius.full,
    alignItems: "center",
    justifyContent: "center",
  },
  upRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingVertical: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    borderRadius: theme.borderRadius.md,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.background,
  },
  upRowText: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.semibold,
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
