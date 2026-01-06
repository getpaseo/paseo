import { useState, useCallback } from "react";
import { View, Text, ActivityIndicator, Pressable, RefreshControl } from "react-native";
import { ScrollView } from "react-native-gesture-handler";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { ChevronRight } from "lucide-react-native";
import { useSessionStore } from "@/stores/session-store";
import { useGitDiffQuery } from "@/hooks/use-git-diff-query";

interface ParsedDiffFile {
  path: string;
  isNew: boolean;
  additions: number;
  deletions: number;
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

    // Check for new file indicator
    const isNew = section.includes("new file mode") || section.includes("/dev/null");

    // Extract path - handle both regular and new file formats
    let path = "unknown";
    const pathMatch = firstLine.match(/a\/(.*?) b\//);
    if (pathMatch) {
      path = pathMatch[1];
    } else {
      // For new files from /dev/null, extract from b/...
      const newFileMatch = firstLine.match(/b\/(.+)$/);
      if (newFileMatch) {
        path = newFileMatch[1];
      }
    }

    const parsedLines: ParsedDiffFile["lines"] = [];
    let additions = 0;
    let deletions = 0;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      // Skip metadata lines
      if (i === 0) continue;
      if (line.startsWith("index ")) continue;
      if (line.startsWith("--- ")) continue;
      if (line.startsWith("+++ ")) continue;
      if (line.startsWith("new file mode")) continue;

      if (line.startsWith("@@")) {
        const hunkMatch = line.match(/^(@@ .+? @@)/);
        const hunkHeader = hunkMatch ? hunkMatch[1] : line;
        parsedLines.push({ type: "header", content: hunkHeader });
      } else if (line.startsWith("+")) {
        parsedLines.push({ type: "add", content: line.slice(1) });
        additions++;
      } else if (line.startsWith("-")) {
        parsedLines.push({ type: "remove", content: line.slice(1) });
        deletions++;
      } else if (line.startsWith(" ")) {
        parsedLines.push({ type: "context", content: line.slice(1) });
      } else if (line.length > 0) {
        parsedLines.push({ type: "context", content: line });
      }
    }

    files.push({ path, isNew, additions, deletions, lines: parsedLines });
  }

  return files;
}

interface DiffFileSectionProps {
  file: ParsedDiffFile;
  defaultExpanded?: boolean;
}

function DiffFileSection({ file, defaultExpanded = true }: DiffFileSectionProps) {
  const { theme } = useUnistyles();
  const [isExpanded, setIsExpanded] = useState(defaultExpanded);

  const toggleExpanded = useCallback(() => {
    setIsExpanded((prev) => !prev);
  }, []);

  return (
    <View style={styles.fileSection}>
      <Pressable
        style={({ pressed }) => [
          styles.fileHeader,
          pressed && styles.fileHeaderPressed,
        ]}
        onPress={toggleExpanded}
      >
        <View style={styles.fileHeaderLeft}>
          <View
            style={[
              styles.chevronContainer,
              isExpanded && styles.chevronExpanded,
            ]}
          >
            <ChevronRight
              size={16}
              color={theme.colors.mutedForeground}
            />
          </View>
          <Text style={styles.filePath} numberOfLines={1} ellipsizeMode="middle">
            {file.path}
          </Text>
          {file.isNew && (
            <View style={styles.newBadge}>
              <Text style={styles.newBadgeText}>New</Text>
            </View>
          )}
        </View>
        <View style={styles.fileHeaderRight}>
          <Text style={styles.additions}>+{file.additions}</Text>
          <Text style={styles.deletions}>-{file.deletions}</Text>
        </View>
      </Pressable>
      {isExpanded && (
        <View style={styles.diffContent}>
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
                {line.content || " "}
              </Text>
            </View>
          ))}
        </View>
      )}
    </View>
  );
}

interface GitDiffPaneProps {
  serverId: string;
  agentId: string;
}

export function GitDiffPane({ serverId, agentId }: GitDiffPaneProps) {
  const { theme } = useUnistyles();
  const { diff, isLoading, isFetching, isError, error, refresh } = useGitDiffQuery({
    serverId,
    agentId,
  });

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
          <DiffFileSection key={fileIndex} file={file} />
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
    gap: theme.spacing[3],
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
    borderRadius: theme.borderRadius.lg,
    overflow: "hidden",
    backgroundColor: theme.colors.card,
  },
  fileHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    padding: theme.spacing[3],
    paddingVertical: theme.spacing[4],
    gap: theme.spacing[3],
  },
  fileHeaderPressed: {
    opacity: 0.7,
  },
  fileHeaderLeft: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    flex: 1,
    minWidth: 0,
  },
  fileHeaderRight: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    flexShrink: 0,
  },
  chevronContainer: {
    transform: [{ rotate: "0deg" }],
  },
  chevronExpanded: {
    transform: [{ rotate: "90deg" }],
  },
  filePath: {
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.normal,
    color: theme.colors.foreground,
    fontFamily: "monospace",
    flex: 1,
  },
  newBadge: {
    backgroundColor: theme.colors.palette.green[800],
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1],
    borderRadius: theme.borderRadius.md,
    flexShrink: 0,
  },
  newBadgeText: {
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.semibold,
    color: theme.colors.palette.green[200],
  },
  additions: {
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.semibold,
    color: theme.colors.palette.green[400],
    fontFamily: "monospace",
  },
  deletions: {
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.semibold,
    color: theme.colors.palette.red[500],
    fontFamily: "monospace",
  },
  diffContent: {
    borderTopWidth: theme.borderWidth[1],
    borderTopColor: theme.colors.border,
  },
  diffLineContainer: {
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[1],
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
