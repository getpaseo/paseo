import { useState, useCallback, useEffect, useId, useRef } from "react";
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

type HighlightStyle = NonNullable<HighlightToken["style"]>;

interface HighlightedTextProps {
  tokens: HighlightToken[];
  baseStyle: HighlightStyle | null;
  lineType: "add" | "remove" | "context" | "header";
}

function HighlightedText({ tokens, lineType }: HighlightedTextProps) {
  const { theme } = useUnistyles();

  // Get color for a highlight style using GitHub Dark theme
  // Text colors are the same regardless of line type - only background changes
  const getTokenColor = (style: HighlightStyle | null): string => {
    const baseColor = "#c9d1d9"; // GitHub foreground

    if (!style) return baseColor;

    // GitHub Dark theme colors
    const highlightColors: Record<HighlightStyle, string> = {
      keyword: "#ff7b72", // red
      comment: "#8b949e", // gray
      string: "#a5d6ff", // light blue
      number: "#79c0ff", // blue
      literal: "#79c0ff", // blue
      function: "#d2a8ff", // purple
      definition: "#d2a8ff", // purple
      class: "#ffa657", // orange
      type: "#ff7b72", // red (same as keyword in GitHub)
      tag: "#7ee787", // green
      attribute: "#79c0ff", // blue
      property: "#79c0ff", // blue
      variable: baseColor,
      operator: "#79c0ff", // blue
      punctuation: "#c9d1d9", // foreground
      regexp: "#a5d6ff", // light blue
      escape: "#79c0ff", // blue
      meta: "#8b949e", // gray
      heading: "#79c0ff", // blue
      link: "#a5d6ff", // light blue
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

function DiffFileSection({ file, defaultExpanded = true, testID }: DiffFileSectionProps) {
  const { theme } = useUnistyles();
  const [isExpanded, setIsExpanded] = useState(defaultExpanded);
  const [scrollViewWidth, setScrollViewWidth] = useState(0);
  const [isAtLeftEdge, setIsAtLeftEdge] = useState(true);
  const horizontalScroll = useHorizontalScrollOptional();
  const scrollId = useId();
  const scrollViewRef = useRef<ScrollViewType>(null);

  // Get the close gesture ref from animation context (may not be available outside sidebar)
  let closeGestureRef: React.MutableRefObject<any> | undefined;
  try {
    const animation = useExplorerSidebarAnimation();
    closeGestureRef = animation.closeGestureRef;
  } catch {
    // Not inside ExplorerSidebarAnimationProvider, which is fine
  }

  const toggleExpanded = useCallback(() => {
    setIsExpanded((prev) => !prev);
  }, []);

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
}

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

  const handleRefresh = useCallback(() => {
    setIsManualRefresh(true);
    refresh();
  }, [refresh]);

  // Reset manual refresh flag when fetch completes
  useEffect(() => {
    if (!isFetching && isManualRefresh) {
      setIsManualRefresh(false);
    }
  }, [isFetching, isManualRefresh]);

  const agentExists = useSessionStore((state) =>
    state.sessions[serverId]?.agents?.has(agentId) ?? false
  );

  const renderFileSection: ListRenderItem<ParsedDiffFile> = useCallback(
    ({ item, index }) => (
      <DiffFileSection file={item} testID={`diff-file-${index}`} />
    ),
    []
  );

  const keyExtractor = useCallback(
    (item: ParsedDiffFile, index: number) => `${item.path}-${index}`,
    []
  );

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
    backgroundColor: theme.colors.muted,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.accentBorder,
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
    backgroundColor: "#0d1117",
  },
  diffContentInner: {
    flexDirection: "column",
  },
  linesContainer: {
    backgroundColor: "#0d1117",
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
    color: "#c9d1d9", // Same text color as all code
  },
  removeLineContainer: {
    backgroundColor: "rgba(248, 81, 73, 0.1)", // GitHub red
  },
  removeLineText: {
    color: "#c9d1d9", // Same text color as all code
  },
  headerLineContainer: {
    backgroundColor: theme.colors.muted,
  },
  headerLineText: {
    color: theme.colors.mutedForeground,
  },
  contextLineContainer: {
    backgroundColor: "#0d1117",
  },
  contextLineText: {
    color: theme.colors.mutedForeground,
  },
}));
