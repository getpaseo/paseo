import { useState, useCallback, useEffect, useId, useMemo, useRef, memo } from "react";
import {
  View,
  Text,
  ActivityIndicator,
  Pressable,
  FlatList,
  type NativeSyntheticEvent,
  type NativeScrollEvent,
  type ListRenderItem,
} from "react-native";
import { ScrollView, type ScrollView as ScrollViewType } from "react-native-gesture-handler";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { ChevronRight } from "lucide-react-native";
import { useSessionStore } from "@/stores/session-store";
import {
  useHighlightedDiffQuery,
  type ParsedDiffFile,
  type DiffLine,
  type HighlightToken,
} from "@/hooks/use-highlighted-diff-query";
import { useHorizontalScrollOptional } from "@/contexts/horizontal-scroll-context";
import { useExplorerSidebarAnimation } from "@/contexts/explorer-sidebar-animation-context";
import { Fonts } from "@/constants/theme";
import { getNowMs, isPerfLoggingEnabled, perfLog } from "@/utils/perf";

const DIFF_PANE_LOG_TAG = "[GitDiffPane]";
const DIFF_FILE_LOG_TAG = "[DiffFileSection]";
const DIFF_FILE_LOG_LINE_THRESHOLD = 500;
const DIFF_FILE_LOG_TOKEN_THRESHOLD = 5000;

type HighlightStyle = NonNullable<HighlightToken["style"]>;

interface HighlightedTextProps {
  tokens: HighlightToken[];
  baseStyle: HighlightStyle | null;
  lineType: "add" | "remove" | "context" | "header";
}

// GitHub syntax highlight colors for dark/light modes
const darkHighlightColors: Record<HighlightStyle, string> = {
  keyword: "#ff7b72",
  comment: "#8b949e",
  string: "#a5d6ff",
  number: "#79c0ff",
  literal: "#79c0ff",
  function: "#d2a8ff",
  definition: "#d2a8ff",
  class: "#ffa657",
  type: "#ff7b72",
  tag: "#7ee787",
  attribute: "#79c0ff",
  property: "#79c0ff",
  variable: "#c9d1d9",
  operator: "#79c0ff",
  punctuation: "#c9d1d9",
  regexp: "#a5d6ff",
  escape: "#79c0ff",
  meta: "#8b949e",
  heading: "#79c0ff",
  link: "#a5d6ff",
};

const lightHighlightColors: Record<HighlightStyle, string> = {
  keyword: "#cf222e",
  comment: "#6e7781",
  string: "#0a3069",
  number: "#0550ae",
  literal: "#0550ae",
  function: "#8250df",
  definition: "#8250df",
  class: "#953800",
  type: "#cf222e",
  tag: "#116329",
  attribute: "#0550ae",
  property: "#0550ae",
  variable: "#24292f",
  operator: "#0550ae",
  punctuation: "#24292f",
  regexp: "#0a3069",
  escape: "#0550ae",
  meta: "#6e7781",
  heading: "#0550ae",
  link: "#0a3069",
};

function HighlightedText({ tokens, lineType }: HighlightedTextProps) {
  const { theme } = useUnistyles();
  const isDark = theme.colors.surface0 === "#18181c";

  // Get color for a highlight style
  const getTokenColor = (style: HighlightStyle | null): string => {
    const baseColor = isDark ? "#c9d1d9" : "#24292f";
    if (!style) return baseColor;
    const colors = isDark ? darkHighlightColors : lightHighlightColors;
    return colors[style] ?? baseColor;
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
  isExpanded: boolean;
  onToggle: (path: string) => void;
  testID?: string;
}

function DiffLineView({ line }: { line: DiffLine }) {
  return (
    <View
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
  );
}

const DiffFileSection = memo(function DiffFileSection({
  file,
  isExpanded,
  onToggle,
  testID,
}: DiffFileSectionProps) {
  const { theme } = useUnistyles();
  const [scrollViewWidth, setScrollViewWidth] = useState(0);
  const [isAtLeftEdge, setIsAtLeftEdge] = useState(true);
  const horizontalScroll = useHorizontalScrollOptional();
  const scrollId = useId();
  const scrollViewRef = useRef<ScrollViewType>(null);
  const expandStartRef = useRef<number | null>(null);

  const { hunkCount, lineCount, tokenCount } = useMemo(() => {
    let totalLines = 0;
    let totalTokens = 0;
    for (const hunk of file.hunks) {
      totalLines += hunk.lines.length;
      for (const line of hunk.lines) {
        if (line.tokens) {
          totalTokens += line.tokens.length;
        }
      }
    }
    return {
      hunkCount: file.hunks.length,
      lineCount: totalLines,
      tokenCount: totalTokens,
    };
  }, [file]);

  const shouldLogFileMetrics =
    lineCount >= DIFF_FILE_LOG_LINE_THRESHOLD ||
    tokenCount >= DIFF_FILE_LOG_TOKEN_THRESHOLD;

  // Get the close gesture ref from animation context (may not be available outside sidebar)
  let closeGestureRef: React.MutableRefObject<any> | undefined;
  try {
    const animation = useExplorerSidebarAnimation();
    closeGestureRef = animation.closeGestureRef;
  } catch {
    // Not inside ExplorerSidebarAnimationProvider, which is fine
  }

  const toggleExpanded = useCallback(() => {
    if (isPerfLoggingEnabled() && shouldLogFileMetrics) {
      expandStartRef.current = getNowMs();
      perfLog(DIFF_FILE_LOG_TAG, {
        event: "toggle",
        path: file.path,
        nextExpanded: !isExpanded,
        hunkCount,
        lineCount,
        tokenCount,
      });
    }
    onToggle(file.path);
  }, [file.path, onToggle, isExpanded, hunkCount, lineCount, tokenCount, shouldLogFileMetrics]);

  useEffect(() => {
    if (!isPerfLoggingEnabled() || !shouldLogFileMetrics) {
      return;
    }
    const startMs = expandStartRef.current;
    if (startMs === null) {
      return;
    }
    expandStartRef.current = null;
    const logCommit = () => {
      const durationMs = getNowMs() - startMs;
      perfLog(DIFF_FILE_LOG_TAG, {
        event: isExpanded ? "expand_commit" : "collapse_commit",
        path: file.path,
        durationMs: Math.round(durationMs),
        hunkCount,
        lineCount,
        tokenCount,
      });
    };
    if (typeof requestAnimationFrame === "function") {
      requestAnimationFrame(() => logCommit());
    } else {
      logCommit();
    }
  }, [isExpanded, file.path, hunkCount, lineCount, tokenCount, shouldLogFileMetrics]);

  // Register/unregister scroll offset tracking
  useEffect(() => {
    if (!horizontalScroll || !isExpanded) return;
    // Start at 0 (not scrolled)
    horizontalScroll.registerScrollOffset(scrollId, 0);
    return () => {
      horizontalScroll.unregisterScrollOffset(scrollId);
    };
  }, [horizontalScroll, isExpanded, scrollId]);

  const handleScroll = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      const offsetX = event.nativeEvent.contentOffset.x;
      // Track if we're at the left edge (with small threshold for float precision)
      setIsAtLeftEdge(offsetX <= 1);
      if (horizontalScroll) {
        horizontalScroll.registerScrollOffset(scrollId, offsetX);
      }
    },
    [horizontalScroll, scrollId]
  );

  return (
    <View style={styles.fileSection} testID={testID}>
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
              color={theme.colors.foregroundMuted}
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
        <ScrollView
          ref={scrollViewRef}
          horizontal
          nestedScrollEnabled
          showsHorizontalScrollIndicator
          bounces={false}
          style={styles.diffContent}
          contentContainerStyle={styles.diffContentInner}
          onScroll={handleScroll}
          scrollEventThrottle={16}
          onLayout={(e) => setScrollViewWidth(e.nativeEvent.layout.width)}
          // When at left edge, wait for close gesture to fail before scrolling.
          // The close gesture fails quickly on leftward swipes (failOffsetX=-10),
          // so scrolling left works normally. On rightward swipes, close gesture
          // activates and closes the sidebar.
          waitFor={isAtLeftEdge && closeGestureRef?.current ? closeGestureRef : undefined}
        >
          <View style={[styles.linesContainer, scrollViewWidth > 0 && { minWidth: scrollViewWidth }]}>
            {file.hunks.map((hunk, hunkIndex) =>
              hunk.lines.map((line, lineIndex) => (
                <DiffLineView key={`${hunkIndex}-${lineIndex}`} line={line} />
              ))
            )}
          </View>
        </ScrollView>
      )}
    </View>
  );
});

interface GitDiffPaneProps {
  serverId: string;
  agentId: string;
}

export function GitDiffPane({ serverId, agentId }: GitDiffPaneProps) {
  const { theme } = useUnistyles();
  const { files, isLoading, isFetching, isError, error, refresh } = useHighlightedDiffQuery({
    serverId,
    agentId,
  });
  // Track user-initiated refresh to avoid iOS RefreshControl animation on background fetches
  const [isManualRefresh, setIsManualRefresh] = useState(false);
  const [expandedByPath, setExpandedByPath] = useState<Record<string, boolean>>({});
  const diffMetrics = useMemo(() => {
    let hunkCount = 0;
    let lineCount = 0;
    let tokenCount = 0;
    for (const file of files) {
      hunkCount += file.hunks.length;
      for (const hunk of file.hunks) {
        lineCount += hunk.lines.length;
        for (const line of hunk.lines) {
          if (line.tokens) {
            tokenCount += line.tokens.length;
          }
        }
      }
    }
    return {
      fileCount: files.length,
      hunkCount,
      lineCount,
      tokenCount,
    };
  }, [files]);
  const lastMetricsKeyRef = useRef<string | null>(null);

  const handleRefresh = useCallback(() => {
    setIsManualRefresh(true);
    refresh();
  }, [refresh]);

  const handleToggleExpanded = useCallback((path: string) => {
    setExpandedByPath((prev) => ({
      ...prev,
      [path]: !prev[path],
    }));
  }, []);

  // Reset manual refresh flag when fetch completes
  useEffect(() => {
    if (!isFetching && isManualRefresh) {
      setIsManualRefresh(false);
    }
  }, [isFetching, isManualRefresh]);

  useEffect(() => {
    if (!isPerfLoggingEnabled()) {
      return;
    }
    const metricsKey = `${diffMetrics.fileCount}:${diffMetrics.hunkCount}:${diffMetrics.lineCount}:${diffMetrics.tokenCount}`;
    if (lastMetricsKeyRef.current === metricsKey) {
      return;
    }
    lastMetricsKeyRef.current = metricsKey;
    perfLog(DIFF_PANE_LOG_TAG, {
      event: "files_snapshot",
      serverId,
      agentId,
      fileCount: diffMetrics.fileCount,
      hunkCount: diffMetrics.hunkCount,
      lineCount: diffMetrics.lineCount,
      tokenCount: diffMetrics.tokenCount,
      isLoading,
      isFetching,
    });
  }, [agentId, diffMetrics, isFetching, isLoading, serverId]);

  const agentExists = useSessionStore((state) =>
    state.sessions[serverId]?.agents?.has(agentId) ?? false
  );

  const renderFileSection: ListRenderItem<ParsedDiffFile> = useCallback(
    ({ item, index }) => (
      <DiffFileSection
        file={item}
        isExpanded={expandedByPath[item.path] ?? false}
        onToggle={handleToggleExpanded}
        testID={`diff-file-${index}`}
      />
    ),
    [expandedByPath, handleToggleExpanded]
  );

  const keyExtractor = useCallback((item: ParsedDiffFile) => item.path, []);

  if (!agentExists) {
    return (
      <View style={styles.errorContainer}>
        <Text style={styles.errorText}>Agent not found</Text>
      </View>
    );
  }

  const hasChanges = files.length > 0;
  const errorMessage = isError && error instanceof Error ? error.message : null;

  if (isLoading) {
    return (
      <View style={styles.loadingContainer}>
        <ActivityIndicator size="large" />
        <Text style={styles.loadingText}>Loading changes...</Text>
      </View>
    );
  }

  if (isError) {
    return (
      <View style={styles.errorContainer}>
        <Text style={styles.errorText}>{errorMessage ?? "Failed to load changes"}</Text>
      </View>
    );
  }

  if (!hasChanges) {
    return (
      <View style={styles.emptyContainer}>
        <Text style={styles.emptyText}>No changes</Text>
      </View>
    );
  }

  return (
    <FlatList
      data={files}
      renderItem={renderFileSection}
      keyExtractor={keyExtractor}
      extraData={expandedByPath}
      style={styles.scrollView}
      contentContainerStyle={styles.contentContainer}
      testID="git-diff-scroll"
      onRefresh={handleRefresh}
      refreshing={isManualRefresh && isFetching}
      initialNumToRender={3}
      maxToRenderPerBatch={3}
      windowSize={5}
    />
  );
}

const styles = StyleSheet.create((theme) => ({
  scrollView: {
    flex: 1,
  },
  contentContainer: {
    paddingHorizontal: theme.spacing[2],
    paddingTop: theme.spacing[3],
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
    color: theme.colors.foregroundMuted,
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
    color: theme.colors.foregroundMuted,
  },
  fileSection: {
    borderRadius: theme.borderRadius.lg,
    overflow: "hidden",
    backgroundColor: theme.colors.surface2,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.borderAccent,
    marginBottom: theme.spacing[2],
  },
  fileHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    padding: theme.spacing[2],
    paddingVertical: theme.spacing[2],
    gap: theme.spacing[2],
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
    fontFamily: Fonts.mono,
    flex: 1,
  },
  newBadge: {
    backgroundColor: "rgba(46, 160, 67, 0.2)",
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1],
    borderRadius: theme.borderRadius.md,
    flexShrink: 0,
  },
  newBadgeText: {
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.normal,
    color: theme.colors.palette.green[400],
  },
  additions: {
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.normal,
    color: theme.colors.palette.green[400],
    fontFamily: Fonts.mono,
  },
  deletions: {
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.normal,
    color: theme.colors.palette.red[500],
    fontFamily: Fonts.mono,
  },
  diffContent: {
    borderTopWidth: theme.borderWidth[1],
    borderTopColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
  },
  diffContentInner: {
    flexDirection: "column",
  },
  linesContainer: {
    backgroundColor: theme.colors.surface1,
  },
  diffLineContainer: {
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[1],
  },
  diffLineText: {
    fontSize: theme.fontSize.xs,
    fontFamily: Fonts.mono,
    color: theme.colors.foreground,
  },
  addLineContainer: {
    backgroundColor: "rgba(46, 160, 67, 0.15)", // GitHub green
  },
  addLineText: {
    color: theme.colors.foreground,
  },
  removeLineContainer: {
    backgroundColor: "rgba(248, 81, 73, 0.1)", // GitHub red
  },
  removeLineText: {
    color: theme.colors.foreground,
  },
  headerLineContainer: {
    backgroundColor: theme.colors.surface2,
  },
  headerLineText: {
    color: theme.colors.foregroundMuted,
  },
  contextLineContainer: {
    backgroundColor: theme.colors.surface1,
  },
  contextLineText: {
    color: theme.colors.foregroundMuted,
  },
}));
