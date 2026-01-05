import { View, Text, ActivityIndicator, Platform, RefreshControl } from "react-native";
import { Gesture, GestureDetector, ScrollView } from "react-native-gesture-handler";
import { StyleSheet, UnistylesRuntime, useUnistyles } from "react-native-unistyles";
import { useExplorerSidebarAnimation } from "@/contexts/explorer-sidebar-animation-context";
import { useSessionStore } from "@/stores/session-store";
import { useGitDiffQuery } from "@/hooks/use-git-diff-query";

interface ParsedDiffFile {
  path: string;
  lines: Array<{
    type: "add" | "remove" | "context" | "header";
    content: string;
  }>;
}

function parseDiff(diffText: string): ParsedDiffFile[] {
  if (!diffText || diffText.trim().length === 0) {
    return [];
  }

  const files: ParsedDiffFile[] = [];
  const sections = diffText.split(/^diff --git /m).filter(Boolean);

  for (const section of sections) {
    const lines = section.split("\n");
    const firstLine = lines[0];

    const pathMatch = firstLine.match(/a\/(.*?) b\//);
    const path = pathMatch ? pathMatch[1] : "unknown";

    const parsedLines: ParsedDiffFile["lines"] = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      // Skip metadata lines - they're noise in the UI
      // - First line (a/... b/...) - already shown in file header
      // - index ... - git hash info, not useful
      // - --- a/... and +++ b/... - file markers, redundant
      if (i === 0) continue;
      if (line.startsWith("index ")) continue;
      if (line.startsWith("--- ")) continue;
      if (line.startsWith("+++ ")) continue;

      if (line.startsWith("@@")) {
        // Extract just the line numbers portion from @@ -x,y +x,y @@ context
        const hunkMatch = line.match(/^(@@ .+? @@)/);
        const hunkHeader = hunkMatch ? hunkMatch[1] : line;
        parsedLines.push({ type: "header", content: hunkHeader });
      } else if (line.startsWith("+")) {
        parsedLines.push({ type: "add", content: line.slice(1) });
      } else if (line.startsWith("-")) {
        parsedLines.push({ type: "remove", content: line.slice(1) });
      } else if (line.startsWith(" ")) {
        parsedLines.push({ type: "context", content: line.slice(1) });
      } else if (line.length > 0) {
        // Non-empty lines without prefix (rare, but handle gracefully)
        parsedLines.push({ type: "context", content: line });
      }
    }

    files.push({ path, lines: parsedLines });
  }

  return files;
}

interface GitDiffPaneProps {
  serverId: string;
  agentId: string;
}

export function GitDiffPane({ serverId, agentId }: GitDiffPaneProps) {
  const { theme } = useUnistyles();
  const { closeGestureRef } = useExplorerSidebarAnimation();
  const { diff, isLoading, isFetching, isError, error, refresh } = useGitDiffQuery({
    serverId,
    agentId,
  });

  const isMobile =
    UnistylesRuntime.breakpoint === "xs" || UnistylesRuntime.breakpoint === "sm";

  // Pan gesture gate: only allow horizontal scroll after deliberate horizontal movement
  // This prevents diagonal scrolling from being captured by horizontal ScrollView
  const horizontalScrollGate = Gesture.Pan()
    .enabled(isMobile)
    .activeOffsetX([-15, 15]) // Require 15px horizontal movement to activate
    .failOffsetY([-10, 10]) // Fail if 10px vertical movement happens first
    .blocksExternalGesture(closeGestureRef); // Block sidebar close while scrolling

  const agent = useSessionStore((state) =>
    state.sessions[serverId]?.agents?.get(agentId)
  );

  if (!agent) {
    return (
      <View style={styles.errorContainer}>
        <Text style={styles.errorText}>Agent not found</Text>
      </View>
    );
  }

  const parsedFiles = isError || !diff ? [] : parseDiff(diff);
  const hasChanges = parsedFiles.length > 0;
  const errorMessage = isError && error instanceof Error ? error.message : null;

  return (
    <ScrollView
      style={styles.scrollView}
      contentContainerStyle={styles.contentContainer}
      refreshControl={
        <RefreshControl
          refreshing={isFetching && !isLoading}
          onRefresh={refresh}
          tintColor={theme.colors.mutedForeground}
          colors={[theme.colors.primary]}
        />
      }
    >
      {isLoading ? (
        <View style={styles.loadingContainer}>
          <ActivityIndicator size="large" />
          <Text style={styles.loadingText}>Loading changes...</Text>
        </View>
      ) : isError ? (
        <View style={styles.errorContainer}>
          <Text style={styles.errorText}>{errorMessage ?? "Failed to load changes"}</Text>
        </View>
      ) : !hasChanges ? (
        <View style={styles.emptyContainer}>
          <Text style={styles.emptyText}>No changes</Text>
        </View>
      ) : (
        parsedFiles.map((file, fileIndex) => (
          <View key={fileIndex} style={styles.fileSection}>
            <View style={styles.fileHeader}>
              <Text style={styles.filePath}>{file.path}</Text>
            </View>
            <View style={styles.diffContent}>
              <GestureDetector gesture={horizontalScrollGate}>
                <ScrollView
                  horizontal
                  showsHorizontalScrollIndicator
                  nestedScrollEnabled
                  directionalLockEnabled={Platform.OS === "ios"}
                >
                  <View style={styles.diffLinesContainer}>
                  {file.lines.map((line, lineIndex) => (
                    <View
                      key={lineIndex}
                      style={[
                        styles.diffLineContainer,
                        line.type === "add" && styles.addLineContainer,
                        line.type === "remove" && styles.removeLineContainer,
                        line.type === "header" && styles.headerLineContainer,
                        line.type === "context" && styles.contextLineContainer,
                      ]}
                    >
                      <Text
                        style={[
                          styles.diffLineText,
                          line.type === "add" && styles.addLineText,
                          line.type === "remove" && styles.removeLineText,
                          line.type === "header" && styles.headerLineText,
                          line.type === "context" && styles.contextLineText,
                        ]}
                      >
                        {line.content}
                      </Text>
                    </View>
                  ))}
                  </View>
                </ScrollView>
              </GestureDetector>
            </View>
          </View>
        ))
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create((theme) => ({
  scrollView: {
    flex: 1,
  },
  contentContainer: {
    padding: theme.spacing[4],
    paddingBottom: theme.spacing[8],
  },
  loadingContainer: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingTop: theme.spacing[16],
    gap: theme.spacing[4],
  },
  loadingText: {
    fontSize: theme.fontSize.base,
    color: theme.colors.mutedForeground,
  },
  errorContainer: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingTop: theme.spacing[16],
    paddingHorizontal: theme.spacing[6],
  },
  errorText: {
    fontSize: theme.fontSize.base,
    color: theme.colors.destructive,
    textAlign: "center",
  },
  emptyContainer: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingTop: theme.spacing[16],
  },
  emptyText: {
    fontSize: theme.fontSize.lg,
    color: theme.colors.mutedForeground,
  },
  fileSection: {
    marginBottom: theme.spacing[6],
    borderRadius: theme.borderRadius.lg,
    overflow: "hidden",
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    width: "100%",
  },
  fileHeader: {
    backgroundColor: theme.colors.muted,
    padding: theme.spacing[3],
    borderBottomWidth: theme.borderWidth[1],
    borderBottomColor: theme.colors.border,
  },
  filePath: {
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.semibold,
    color: theme.colors.foreground,
    fontFamily: "monospace",
  },
  diffContent: {
    backgroundColor: theme.colors.card,
  },
  diffLinesContainer: {
    minWidth: "100%",
  },
  diffLineContainer: {
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[1],
    flexDirection: "row",
    alignItems: "flex-start",
  },
  diffLineText: {
    fontSize: theme.fontSize.xs,
    fontFamily: "monospace",
    color: theme.colors.foreground,
  },
  addLineContainer: {
    backgroundColor: theme.colors.palette.green[900],
  },
  addLineText: {
    color: theme.colors.palette.green[200],
  },
  removeLineContainer: {
    backgroundColor: theme.colors.palette.red[900],
  },
  removeLineText: {
    color: theme.colors.palette.red[200],
  },
  headerLineContainer: {
    backgroundColor: theme.colors.muted,
  },
  headerLineText: {
    color: theme.colors.mutedForeground,
  },
  contextLineContainer: {
    backgroundColor: theme.colors.card,
  },
  contextLineText: {
    color: theme.colors.mutedForeground,
  },
}));
