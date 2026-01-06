import { useState, useCallback, useMemo } from "react";
import { View, Text, ActivityIndicator, Pressable, RefreshControl } from "react-native";
import { ScrollView } from "react-native-gesture-handler";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { ChevronRight } from "lucide-react-native";
import { useSessionStore } from "@/stores/session-store";
import { useGitDiffQuery } from "@/hooks/use-git-diff-query";
import {
  highlightCode,
  isLanguageSupported,
  type HighlightToken,
  type HighlightStyle,
} from "@/utils/syntax-highlighter";

interface DiffLine {
  type: "add" | "remove" | "context" | "header";
  content: string;
  tokens?: HighlightToken[];
}

interface ParsedDiffFile {
  path: string;
  isNew: boolean;
  additions: number;
  deletions: number;
  lines: DiffLine[];
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

    const parsedLines: DiffLine[] = [];
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

function applyHighlighting(files: ParsedDiffFile[]): ParsedDiffFile[] {
  return files.map((file) => {
    if (!isLanguageSupported(file.path)) {
      return file;
    }

    // Collect all non-header lines to build the "file content" for highlighting
    // We need to build separate content for add/context and remove/context
    // to properly highlight each side of the diff
    const addContextLines: Array<{ index: number; content: string }> = [];
    const removeLines: Array<{ index: number; content: string }> = [];

    file.lines.forEach((line, index) => {
      if (line.type === "add" || line.type === "context") {
        addContextLines.push({ index, content: line.content });
      }
      if (line.type === "remove") {
        removeLines.push({ index, content: line.content });
      }
    });

    // Highlight the "new" file content (additions + context)
    const addContextCode = addContextLines.map((l) => l.content).join("\n");
    const addContextHighlighted = highlightCode(addContextCode, file.path);

    // Highlight the "old" file content (removals only, context already covered)
    const removeCode = removeLines.map((l) => l.content).join("\n");
    const removeHighlighted = highlightCode(removeCode, file.path);

    // Map highlighted tokens back to diff lines
    const newLines = [...file.lines];

    addContextLines.forEach((item, highlightIndex) => {
      if (addContextHighlighted[highlightIndex]) {
        newLines[item.index] = {
          ...newLines[item.index],
          tokens: addContextHighlighted[highlightIndex],
        };
      }
    });

    removeLines.forEach((item, highlightIndex) => {
      if (removeHighlighted[highlightIndex]) {
        newLines[item.index] = {
          ...newLines[item.index],
          tokens: removeHighlighted[highlightIndex],
        };
      }
    });

    return { ...file, lines: newLines };
  });
}

interface HighlightedTextProps {
  tokens: HighlightToken[];
  baseStyle: HighlightStyle | null;
  lineType: "add" | "remove" | "context" | "header";
}

function HighlightedText({ tokens, lineType }: HighlightedTextProps) {
  const { theme } = useUnistyles();

  // Get color for a highlight style, respecting the line type
  const getTokenColor = (style: HighlightStyle | null): string => {
    // For add/remove lines, use appropriate base colors
    const baseColor =
      lineType === "add"
        ? theme.colors.palette.green[200]
        : lineType === "remove"
          ? theme.colors.palette.red[200]
          : theme.colors.mutedForeground;

    if (!style) return baseColor;

    // Define highlight colors - these work on both light and dark backgrounds
    const highlightColors: Record<HighlightStyle, string> = {
      keyword: theme.colors.palette.purple[500],
      comment: theme.colors.mutedForeground,
      string: theme.colors.palette.green[400],
      number: theme.colors.palette.orange[500],
      literal: theme.colors.palette.orange[500],
      function: theme.colors.palette.blue[400],
      definition: theme.colors.palette.blue[400],
      class: theme.colors.palette.yellow[400],
      type: theme.colors.palette.yellow[400],
      tag: theme.colors.palette.red[500],
      attribute: theme.colors.palette.purple[500],
      property: theme.colors.palette.blue[400],
      variable: baseColor,
      operator: baseColor,
      punctuation: baseColor,
      regexp: theme.colors.palette.green[400],
      escape: theme.colors.palette.orange[500],
      meta: theme.colors.mutedForeground,
      heading: theme.colors.palette.blue[400],
      link: theme.colors.palette.blue[400],
    };

    return highlightColors[style] ?? baseColor;
  };

  return (
    <Text style={styles.diffLineText}>
      {tokens.map((token, index) => (
        <Text key={index} style={{ color: getTokenColor(token.style) }}>
          {token.text}
        </Text>
      ))}
    </Text>
  );
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
              {line.tokens && line.type !== "header" ? (
                <HighlightedText
                  tokens={line.tokens}
                  baseStyle={null}
                  lineType={line.type}
                />
              ) : (
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
              )}
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

  const highlightedFiles = useMemo(() => {
    if (isError || !diff) return [];
    const parsed = parseDiff(diff);
    return applyHighlighting(parsed);
  }, [diff, isError]);

  if (!agent) {
    return (
      <View style={styles.errorContainer}>
        <Text style={styles.errorText}>Agent not found</Text>
      </View>
    );
  }

  const hasChanges = highlightedFiles.length > 0;
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
        highlightedFiles.map((file, fileIndex) => (
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
    fontWeight: theme.fontWeight.normal,
    color: theme.colors.palette.green[400],
    fontFamily: "monospace",
  },
  deletions: {
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.normal,
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
