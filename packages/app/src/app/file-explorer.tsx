import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Image,
  Pressable,
  ScrollView,
  Text,
  View,
} from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useLocalSearchParams } from "expo-router";
import { BackHeader } from "@/components/headers/back-header";
import { useSession, type ExplorerEntry } from "@/contexts/session-context";

export default function FileExplorerScreen() {
  const { agentId } = useLocalSearchParams<{ agentId: string }>();
  const {
    agents,
    fileExplorer,
    requestDirectoryListing,
    requestFilePreview,
  } = useSession();
  const [currentPath, setCurrentPath] = useState(".");
  const [selectedEntryPath, setSelectedEntryPath] = useState<string | null>(null);

  const agent = agentId ? agents.get(agentId) : undefined;
  const explorerState = agentId ? fileExplorer.get(agentId) : undefined;
  const directory = explorerState?.directories.get(currentPath);
  const entries = directory?.entries ?? [];
  const isLoading = explorerState?.isLoading ?? false;
  const error = explorerState?.lastError ?? null;
  const preview = selectedEntryPath
    ? explorerState?.files.get(selectedEntryPath)
    : null;

  useEffect(() => {
    if (!agentId) {
      return;
    }
    setCurrentPath(".");
    setSelectedEntryPath(null);
    requestDirectoryListing(agentId, ".");
  }, [agentId, requestDirectoryListing]);

  const parentPath = useMemo(() => {
    if (currentPath === ".") {
      return null;
    }
    const segments = currentPath.split("/");
    segments.pop();
    const nextPath = segments.join("/");
    return nextPath.length === 0 ? "." : nextPath;
  }, [currentPath]);

  const handleEntryPress = useCallback(
    (entry: ExplorerEntry) => {
      if (!agentId) {
        return;
      }

      if (entry.kind === "directory") {
        setCurrentPath(entry.path);
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
    setCurrentPath(parentPath);
    setSelectedEntryPath(null);
    requestDirectoryListing(agentId, parentPath);
  }, [agentId, parentPath, requestDirectoryListing]);

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
      <BackHeader title="Files" />
      <View style={styles.headerRow}>
        <View style={styles.breadcrumbs}>
          <Text style={styles.breadcrumbLabel}>Path</Text>
          <ScrollView horizontal>
            <Text style={styles.breadcrumbText}>{currentPath}</Text>
          </ScrollView>
        </View>
        {parentPath && (
          <Pressable style={styles.upButton} onPress={handleNavigateUp}>
            <Text style={styles.upButtonText}>Up</Text>
          </Pressable>
        )}
      </View>

      <View style={styles.content}>
        <View style={styles.listSection}>
          {error ? (
            <View style={styles.centerState}>
              <Text style={styles.errorText}>{error}</Text>
            </View>
          ) : isLoading && entries.length === 0 ? (
            <View style={styles.centerState}>
              <ActivityIndicator size="small" />
              <Text style={styles.loadingText}>Loading...</Text>
            </View>
          ) : entries.length === 0 ? (
            <View style={styles.centerState}>
              <Text style={styles.emptyText}>Directory is empty</Text>
            </View>
          ) : (
            <ScrollView>
              {entries.map((entry) => (
                <Pressable
                  key={entry.path}
                  style={[
                    styles.entryRow,
                    entry.kind === "directory"
                      ? styles.directoryRow
                      : styles.fileRow,
                    selectedEntryPath === entry.path && styles.selectedRow,
                  ]}
                  onPress={() => handleEntryPress(entry)}
                >
                  <View style={styles.entryTextContainer}>
                    <Text style={styles.entryName}>{entry.name}</Text>
                    <Text style={styles.entryMeta}>
                      {entry.kind.toUpperCase()} ·{" "}
                      {formatFileSize({ size: entry.size })} ·{" "}
                      {formatModifiedTime({ value: entry.modifiedAt })}
                    </Text>
                  </View>
                  <Text style={styles.entryAction}>
                    {entry.kind === "directory" ? "Open" : "Preview"}
                  </Text>
                </Pressable>
              ))}
            </ScrollView>
          )}
        </View>

        <View style={styles.previewSection}>
          {selectedEntryPath && isLoading && !preview ? (
            <View style={styles.centerState}>
              <ActivityIndicator size="small" />
              <Text style={styles.loadingText}>Loading file...</Text>
            </View>
          ) : !selectedEntryPath ? (
            <View style={styles.centerState}>
              <Text style={styles.emptyText}>Select a file to preview</Text>
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
              <Image
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

function formatModifiedTime({ value }: { value: string }): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return date.toLocaleString();
}

const styles = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
    backgroundColor: theme.colors.background,
  },
  headerRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[2],
    gap: theme.spacing[3],
  },
  breadcrumbs: {
    flex: 1,
  },
  breadcrumbLabel: {
    color: theme.colors.mutedForeground,
    fontSize: theme.fontSize.xs,
    marginBottom: theme.spacing[1],
  },
  breadcrumbText: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontFamily: "monospace",
  },
  upButton: {
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[2],
    borderRadius: theme.borderRadius.lg,
    backgroundColor: theme.colors.muted,
  },
  upButtonText: {
    color: theme.colors.foreground,
    fontWeight: theme.fontWeight.semibold,
  },
  content: {
    flex: 1,
    flexDirection: "column",
    paddingHorizontal: theme.spacing[4],
    paddingBottom: theme.spacing[4],
    gap: theme.spacing[4],
  },
  listSection: {
    flex: 1,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.lg,
    padding: theme.spacing[2],
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
    paddingVertical: theme.spacing[3],
    paddingHorizontal: theme.spacing[3],
    borderRadius: theme.borderRadius.md,
    marginBottom: theme.spacing[2],
  },
  directoryRow: {
    backgroundColor: theme.colors.muted,
  },
  fileRow: {
    backgroundColor: theme.colors.card,
  },
  selectedRow: {
    borderWidth: theme.borderWidth[2],
    borderColor: theme.colors.primary,
  },
  entryTextContainer: {
    flex: 1,
    marginRight: theme.spacing[3],
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
  entryAction: {
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
