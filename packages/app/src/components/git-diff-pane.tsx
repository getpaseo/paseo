import { useState, useCallback, useEffect, useId, useMemo, useRef, memo, type ReactElement } from "react";
import { useRouter } from "expo-router";
import {
  View,
  Text,
  ActivityIndicator,
  Pressable,
  FlatList,
  Platform,
  type LayoutChangeEvent,
  type NativeSyntheticEvent,
  type NativeScrollEvent,
} from "react-native";
import { ScrollView, type ScrollView as ScrollViewType } from "react-native-gesture-handler";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import AsyncStorage from "@react-native-async-storage/async-storage";
import {
  Archive,
  ChevronDown,

  GitBranch,
  GitCommitHorizontal,
  GitMerge,
  ListChevronsDownUp,
  ListChevronsUpDown,
  MoreVertical,
  RefreshCcw,
  Upload,
} from "lucide-react-native";
import { useCheckoutGitActionsStore } from "@/stores/checkout-git-actions-store";
import {
  useCheckoutDiffQuery,
  type ParsedDiffFile,
  type DiffLine,
  type HighlightToken,
} from "@/hooks/use-checkout-diff-query";
import { useCheckoutStatusQuery } from "@/hooks/use-checkout-status-query";
import { useCheckoutPrStatusQuery } from "@/hooks/use-checkout-pr-status-query";
import { useHorizontalScrollOptional } from "@/contexts/horizontal-scroll-context";
import { useExplorerSidebarAnimation } from "@/contexts/explorer-sidebar-animation-context";
import { Fonts } from "@/constants/theme";
import { getNowMs, isPerfLoggingEnabled, perfLog } from "@/utils/perf";
import { shouldAnchorHeaderBeforeCollapse } from "@/utils/git-diff-scroll";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  type ActionStatus,
} from "@/components/ui/dropdown-menu";
import { GitHubIcon } from "@/components/icons/github-icon";
import { buildHostAgentDraftRoute } from "@/utils/host-routes";
import { openExternalUrl } from "@/utils/open-external-url";

// =============================================================================
// Git Actions Data Structure
// =============================================================================

type GitActionId =
  | "commit"
  | "push"
  | "view-pr"
  | "create-pr"
  | "merge-branch"
  | "merge-from-base"
  | "archive-worktree";

interface GitAction {
  id: GitActionId;
  label: string;
  pendingLabel: string;
  successLabel: string;
  disabled: boolean;
  status: ActionStatus;
  description?: string;
  icon?: ReactElement;
  handler: () => void;
}

interface GitActions {
  primary: GitAction | null;
  secondary: GitAction[];
  menu: GitAction[];
}

function openURLInNewTab(url: string): void {
  void openExternalUrl(url);
}

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
  onHeaderHeightChange?: (path: string, height: number) => void;
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

const DiffFileHeader = memo(function DiffFileHeader({
  file,
  isExpanded,
  onToggle,
  onHeaderHeightChange,
  testID,
}: DiffFileSectionProps) {
  const expandStartRef = useRef<number | null>(null);
  const layoutYRef = useRef<number | null>(null);
  const pressHandledRef = useRef(false);
  const pressInRef = useRef<{ ts: number; pageX: number; pageY: number } | null>(null);

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

  const toggleExpanded = useCallback(() => {
    pressHandledRef.current = true;
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

  return (
    <View
      style={[
        styles.fileSectionHeaderContainer,
        !isExpanded && styles.fileSectionBorder,
      ]}
      onLayout={(event) => {
        layoutYRef.current = event.nativeEvent.layout.y;
        onHeaderHeightChange?.(file.path, event.nativeEvent.layout.height);
      }}
      testID={testID}
    >
      <Pressable
        testID={testID ? `${testID}-toggle` : undefined}
        style={({ pressed }) => [
          styles.fileHeader,
          pressed && styles.fileHeaderPressed,
        ]}
        // Android: prevent parent pan/scroll gestures from canceling the tap release.
        cancelable={false}
        onPressIn={(event) => {
          pressHandledRef.current = false;
          pressInRef.current = {
            ts: Date.now(),
            pageX: event.nativeEvent.pageX,
            pageY: event.nativeEvent.pageY,
          };
        }}
        onPressOut={(event) => {
          if (
            Platform.OS !== "web" &&
            !pressHandledRef.current &&
            layoutYRef.current === 0 &&
            pressInRef.current
          ) {
            const durationMs = Date.now() - pressInRef.current.ts;
            const dx = event.nativeEvent.pageX - pressInRef.current.pageX;
            const dy = event.nativeEvent.pageY - pressInRef.current.pageY;
            const distance = Math.hypot(dx, dy);
            // Sticky headers on Android can emit pressIn/pressOut without onPress.
            // Treat short, low-movement interactions as taps.
            if (durationMs <= 500 && distance <= 12) {
              toggleExpanded();
            }
          }
        }}
        onPress={toggleExpanded}
      >
        <View style={styles.fileHeaderLeft}>
          <Text style={styles.fileName}>{file.path.split("/").pop()}</Text>
          <Text style={styles.fileDir} numberOfLines={1}>
            {file.path.includes("/")
              ? ` ${file.path.slice(0, file.path.lastIndexOf("/"))}`
              : ""}
          </Text>
          {file.isNew && (
            <View style={styles.newBadge}>
              <Text style={styles.newBadgeText}>New</Text>
            </View>
          )}
          {file.isDeleted && (
            <View style={styles.deletedBadge}>
              <Text style={styles.deletedBadgeText}>Deleted</Text>
            </View>
          )}
        </View>
        <View style={styles.fileHeaderRight}>
          <Text style={styles.additions}>+{file.additions}</Text>
          <Text style={styles.deletions}>-{file.deletions}</Text>
        </View>
      </Pressable>
    </View>
  );
});

function DiffFileBody({
  file,
  onBodyHeightChange,
  testID,
}: {
  file: ParsedDiffFile;
  onBodyHeightChange?: (path: string, height: number) => void;
  testID?: string;
}) {
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

  // Register/unregister scroll offset tracking
  useEffect(() => {
    if (!horizontalScroll) return;
    // Start at 0 (not scrolled)
    horizontalScroll.registerScrollOffset(scrollId, 0);
    return () => {
      horizontalScroll.unregisterScrollOffset(scrollId);
    };
  }, [horizontalScroll, scrollId]);

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
    <View
      style={[styles.fileSectionBodyContainer, styles.fileSectionBorder]}
      onLayout={(event) => {
        onBodyHeightChange?.(file.path, event.nativeEvent.layout.height);
      }}
      testID={testID}
    >
      {file.status === "too_large" || file.status === "binary" ? (
        <View style={styles.statusMessageContainer}>
          <Text style={styles.statusMessageText}>
            {file.status === "binary" ? "Binary file" : "Diff too large to display"}
          </Text>
        </View>
      ) : (
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
  cwd: string;
}

type DiffFlatItem =
  | { type: "header"; file: ParsedDiffFile; fileIndex: number; isExpanded: boolean }
  | { type: "body"; file: ParsedDiffFile; fileIndex: number };

export function GitDiffPane({ serverId, agentId, cwd }: GitDiffPaneProps) {
  const { theme } = useUnistyles();
  const router = useRouter();
  const [diffModeOverride, setDiffModeOverride] = useState<"uncommitted" | "base" | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [shipDefault, setShipDefault] = useState<"merge" | "pr">("merge");
  const { status, isLoading: isStatusLoading, isFetching: isStatusFetching, isError: isStatusError, error: statusError, refresh: refreshStatus } =
    useCheckoutStatusQuery({ serverId, cwd });
  const gitStatus = status && status.isGit ? status : null;
  const isGit = Boolean(gitStatus);
  const notGit = status !== null && !status.isGit && !status.error;
  const statusErrorMessage =
    status?.error?.message ??
    (isStatusError && statusError instanceof Error ? statusError.message : null);
  const baseRef = gitStatus?.baseRef ?? undefined;

  // Auto-select diff mode based on state: uncommitted when dirty, base when clean
  const hasUncommittedChanges = Boolean(gitStatus?.isDirty);
  const autoDiffMode = hasUncommittedChanges ? "uncommitted" : "base";
  const diffMode = diffModeOverride ?? autoDiffMode;

  const {
    files,
    payloadError: diffPayloadError,
    isLoading: isDiffLoading,
    isFetching: isDiffFetching,
    isError: isDiffError,
    error: diffError,
    refresh: refreshDiff,
  } = useCheckoutDiffQuery({
    serverId,
    cwd,
    mode: diffMode,
    baseRef,
    enabled: isGit,
  });
  const {
    status: prStatus,
    githubFeaturesEnabled,
    payloadError: prPayloadError,
    refresh: refreshPrStatus,
  } = useCheckoutPrStatusQuery({
    serverId,
    cwd,
    enabled: isGit,
  });
  // Track user-initiated refresh to avoid iOS RefreshControl animation on background fetches
  const [isManualRefresh, setIsManualRefresh] = useState(false);
  const [expandedByPath, setExpandedByPath] = useState<Record<string, boolean>>({});
  const diffListRef = useRef<FlatList<DiffFlatItem>>(null);
  const diffListScrollOffsetRef = useRef(0);
  const diffListViewportHeightRef = useRef(0);
  const headerHeightByPathRef = useRef<Record<string, number>>({});
  const bodyHeightByPathRef = useRef<Record<string, number>>({});
  const defaultHeaderHeightRef = useRef<number>(44);
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
    void refreshDiff();
    void refreshStatus();
    void refreshPrStatus();
  }, [refreshDiff, refreshStatus, refreshPrStatus]);

  const shipDefaultStorageKey = useMemo(() => {
    if (!gitStatus?.repoRoot) {
      return null;
    }
    return `@paseo:changes-ship-default:${gitStatus.repoRoot}`;
  }, [gitStatus?.repoRoot]);

  useEffect(() => {
    if (!shipDefaultStorageKey) {
      return;
    }
    let isActive = true;
    AsyncStorage.getItem(shipDefaultStorageKey)
      .then((value) => {
        if (!isActive) return;
        if (value === "pr" || value === "merge") {
          setShipDefault(value);
        }
      })
      .catch(() => undefined);
    return () => {
      isActive = false;
    };
  }, [shipDefaultStorageKey]);

  const persistShipDefault = useCallback(
    async (next: "merge" | "pr") => {
      setShipDefault(next);
      if (!shipDefaultStorageKey) return;
      try {
        await AsyncStorage.setItem(shipDefaultStorageKey, next);
      } catch {
        // Ignore persistence failures; default will reset to "merge".
      }
    },
    [shipDefaultStorageKey]
  );

  const { flatItems, stickyHeaderIndices } = useMemo(() => {
    const items: DiffFlatItem[] = [];
    const stickyIndices: number[] = [];
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const isExpanded = expandedByPath[file.path] ?? false;
      items.push({ type: "header", file, fileIndex: i, isExpanded });
      if (isExpanded) {
        stickyIndices.push(items.length - 1);
      }
      if (isExpanded) {
        items.push({ type: "body", file, fileIndex: i });
      }
    }
    return { flatItems: items, stickyHeaderIndices: stickyIndices };
  }, [files, expandedByPath]);

  const handleHeaderHeightChange = useCallback((path: string, height: number) => {
    if (!Number.isFinite(height) || height <= 0) {
      return;
    }
    headerHeightByPathRef.current[path] = height;
    defaultHeaderHeightRef.current = height;
  }, []);

  const handleBodyHeightChange = useCallback((path: string, height: number) => {
    if (!Number.isFinite(height) || height < 0) {
      return;
    }
    bodyHeightByPathRef.current[path] = height;
  }, []);

  const handleDiffListScroll = useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
    diffListScrollOffsetRef.current = event.nativeEvent.contentOffset.y;
  }, []);

  const handleDiffListLayout = useCallback((event: LayoutChangeEvent) => {
    const height = event.nativeEvent.layout.height;
    if (!Number.isFinite(height) || height <= 0) {
      return;
    }
    diffListViewportHeightRef.current = height;
  }, []);

  const computeHeaderOffset = useCallback(
    (path: string): number => {
      const defaultHeaderHeight = defaultHeaderHeightRef.current;
      let offset = 0;
      for (const file of files) {
        if (file.path === path) {
          break;
        }
        offset += headerHeightByPathRef.current[file.path] ?? defaultHeaderHeight;
        if (expandedByPath[file.path]) {
          offset += bodyHeightByPathRef.current[file.path] ?? 0;
        }
      }
      return Math.max(0, offset);
    },
    [expandedByPath, files]
  );

  const handleToggleExpanded = useCallback(
    (path: string) => {
      const isCurrentlyExpanded = expandedByPath[path] ?? false;
      const nextExpanded = !isCurrentlyExpanded;
      const targetOffset = isCurrentlyExpanded ? computeHeaderOffset(path) : null;
      const headerHeight = headerHeightByPathRef.current[path] ?? defaultHeaderHeightRef.current;
      const shouldAnchor =
        isCurrentlyExpanded &&
        targetOffset !== null &&
        shouldAnchorHeaderBeforeCollapse({
          headerOffset: targetOffset,
          headerHeight,
          viewportOffset: diffListScrollOffsetRef.current,
          viewportHeight: diffListViewportHeightRef.current,
        });

      // Anchor to the clicked header before collapsing so visual context is preserved.
      if (shouldAnchor && targetOffset !== null) {
        diffListRef.current?.scrollToOffset({
          offset: targetOffset,
          animated: false,
        });
      }

      setExpandedByPath((prev) => ({
        ...prev,
        // Use a deterministic target value (instead of toggling from prev) so duplicate
        // onPress events from sticky headers on Android can't flip back immediately.
        [path]: nextExpanded,
      }));
    },
    [computeHeaderOffset, expandedByPath]
  );

  const allExpanded = useMemo(() => {
    if (files.length === 0) return false;
    return files.every((file) => expandedByPath[file.path]);
  }, [files, expandedByPath]);

  const handleToggleExpandAll = useCallback(() => {
    if (allExpanded) {
      setExpandedByPath({});
    } else {
      const newExpanded: Record<string, boolean> = {};
      for (const file of files) {
        newExpanded[file.path] = true;
      }
      setExpandedByPath(newExpanded);
    }
  }, [allExpanded, files]);

  // Reset manual refresh flag when fetch completes
  useEffect(() => {
    if (!(isDiffFetching || isStatusFetching) && isManualRefresh) {
      setIsManualRefresh(false);
    }
  }, [isDiffFetching, isStatusFetching, isManualRefresh]);

  // Clear diff mode override when auto mode changes (e.g., after commit)
  useEffect(() => {
    setDiffModeOverride(null);
  }, [autoDiffMode]);

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
      isLoading: isDiffLoading,
      isFetching: isDiffFetching,
    });
  }, [agentId, diffMetrics, isDiffFetching, isDiffLoading, serverId]);

  const commitStatus = useCheckoutGitActionsStore((state) =>
    state.getStatus({ serverId, cwd, actionId: "commit" })
  );
  const pushStatus = useCheckoutGitActionsStore((state) =>
    state.getStatus({ serverId, cwd, actionId: "push" })
  );
  const prCreateStatus = useCheckoutGitActionsStore((state) =>
    state.getStatus({ serverId, cwd, actionId: "create-pr" })
  );
  const mergeStatus = useCheckoutGitActionsStore((state) =>
    state.getStatus({ serverId, cwd, actionId: "merge-branch" })
  );
  const mergeFromBaseStatus = useCheckoutGitActionsStore((state) =>
    state.getStatus({ serverId, cwd, actionId: "merge-from-base" })
  );
  const archiveStatus = useCheckoutGitActionsStore((state) =>
    state.getStatus({ serverId, cwd, actionId: "archive-worktree" })
  );

  const runCommit = useCheckoutGitActionsStore((state) => state.commit);
  const runPush = useCheckoutGitActionsStore((state) => state.push);
  const runCreatePr = useCheckoutGitActionsStore((state) => state.createPr);
  const runMergeBranch = useCheckoutGitActionsStore((state) => state.mergeBranch);
  const runMergeFromBase = useCheckoutGitActionsStore((state) => state.mergeFromBase);
  const runArchiveWorktree = useCheckoutGitActionsStore((state) => state.archiveWorktree);

  const handleCommit = useCallback(() => {
    setActionError(null);
    void runCommit({ serverId, cwd }).catch((err) => {
      const message = err instanceof Error ? err.message : "Failed to commit";
      setActionError(message);
    });
  }, [runCommit, serverId, cwd]);

  const handlePush = useCallback(() => {
    setActionError(null);
    void runPush({ serverId, cwd }).catch((err) => {
      const message = err instanceof Error ? err.message : "Failed to push";
      setActionError(message);
    });
  }, [runPush, serverId, cwd]);

  const handleCreatePr = useCallback(() => {
    void persistShipDefault("pr");
    setActionError(null);
    void runCreatePr({ serverId, cwd }).catch((err) => {
      const message = err instanceof Error ? err.message : "Failed to create PR";
      setActionError(message);
    });
  }, [persistShipDefault, runCreatePr, serverId, cwd]);

  const handleMergeBranch = useCallback(() => {
    if (!baseRef) {
      setActionError("Base ref unavailable");
      return;
    }
    void persistShipDefault("merge");
    setActionError(null);
    void runMergeBranch({ serverId, cwd, baseRef }).catch((err) => {
      const message = err instanceof Error ? err.message : "Failed to merge";
      setActionError(message);
    });
  }, [baseRef, persistShipDefault, runMergeBranch, serverId, cwd]);

  const handleMergeFromBase = useCallback(() => {
    if (!baseRef) {
      setActionError("Base ref unavailable");
      return;
    }
    setActionError(null);
    void runMergeFromBase({ serverId, cwd, baseRef }).catch((err) => {
      const message = err instanceof Error ? err.message : "Failed to merge from base";
      setActionError(message);
    });
  }, [baseRef, runMergeFromBase, serverId, cwd]);

  const handleArchiveWorktree = useCallback(() => {
    const worktreePath = status?.cwd;
    if (!worktreePath) {
      setActionError("Worktree path unavailable");
      return;
    }
    setActionError(null);
    void runArchiveWorktree({ serverId, cwd, worktreePath })
      .then(() => {
        router.replace(buildHostAgentDraftRoute(serverId) as any);
      })
      .catch((err) => {
        const message = err instanceof Error ? err.message : "Failed to archive worktree";
        setActionError(message);
      });
  }, [runArchiveWorktree, router, serverId, cwd, status?.cwd]);

  const renderFlatItem = useCallback(
    ({ item }: { item: DiffFlatItem }) => {
      if (item.type === "header") {
        return (
          <DiffFileHeader
            file={item.file}
            isExpanded={item.isExpanded}
            onToggle={handleToggleExpanded}
            onHeaderHeightChange={handleHeaderHeightChange}
            testID={`diff-file-${item.fileIndex}`}
          />
        );
      }
      return (
        <DiffFileBody
          file={item.file}
          onBodyHeightChange={handleBodyHeightChange}
          testID={`diff-file-${item.fileIndex}-body`}
        />
      );
    },
    [handleBodyHeightChange, handleHeaderHeightChange, handleToggleExpanded]
  );

  const flatKeyExtractor = useCallback(
    (item: DiffFlatItem) => `${item.type}-${item.file.path}`,
    []
  );

  const hasChanges = files.length > 0;
  const diffErrorMessage =
    diffPayloadError?.message ??
    (isDiffError && diffError instanceof Error ? diffError.message : null);
  const prErrorMessage = githubFeaturesEnabled ? prPayloadError?.message ?? null : null;
  const branchLabel =
    gitStatus?.currentBranch && gitStatus.currentBranch !== "HEAD"
      ? gitStatus.currentBranch
      : notGit
        ? "Not a git repository"
        : "Unknown";
  const actionsDisabled = !isGit || Boolean(status?.error) || isStatusLoading;
  const aheadCount = gitStatus?.aheadBehind?.ahead ?? 0;
  const aheadOfOrigin = gitStatus?.aheadOfOrigin ?? 0;
  const baseRefLabel = useMemo(() => {
    if (!baseRef) return "base";
    const trimmed = baseRef.replace(/^refs\/(heads|remotes)\//, "").trim();
    return trimmed.startsWith("origin/") ? trimmed.slice("origin/".length) : trimmed;
  }, [baseRef]);
  const committedDiffDescription = useMemo(() => {
    if (!branchLabel || !baseRefLabel) {
      return undefined;
    }
    return branchLabel === baseRefLabel
      ? undefined
      : `${branchLabel} -> ${baseRefLabel}`;
  }, [baseRefLabel, branchLabel]);
  const commitDisabled = actionsDisabled || commitStatus === "pending";
  const prDisabled = actionsDisabled || prCreateStatus === "pending";
  const mergeDisabled =
    actionsDisabled || mergeStatus === "pending" || hasUncommittedChanges || !baseRef;
  const mergeFromBaseDisabled =
    actionsDisabled || mergeFromBaseStatus === "pending" || hasUncommittedChanges || !baseRef;
  const pushDisabled =
    actionsDisabled || pushStatus === "pending" || !(gitStatus?.hasRemote ?? false);
  const archiveDisabled =
    actionsDisabled ||
    archiveStatus === "pending" ||
    !gitStatus?.isPaseoOwnedWorktree;

  let bodyContent: ReactElement;

  if (isStatusLoading) {
    bodyContent = (
      <View style={styles.loadingContainer}>
        <ActivityIndicator size="large" />
        <Text style={styles.loadingText}>Checking repository...</Text>
      </View>
    );
  } else if (statusErrorMessage) {
    bodyContent = (
      <View style={styles.errorContainer}>
        <Text style={styles.errorText}>{statusErrorMessage}</Text>
      </View>
    );
  } else if (notGit) {
    bodyContent = (
      <View style={styles.emptyContainer} testID="changes-not-git">
        <Text style={styles.emptyText}>Not a git repository</Text>
      </View>
    );
  } else if (isDiffLoading) {
    bodyContent = (
      <View style={styles.loadingContainer}>
        <ActivityIndicator size="large" />
        <Text style={styles.loadingText}>Loading changes...</Text>
      </View>
    );
  } else if (diffErrorMessage) {
    bodyContent = (
      <View style={styles.errorContainer}>
        <Text style={styles.errorText}>{diffErrorMessage}</Text>
      </View>
    );
  } else if (!hasChanges) {
    bodyContent = (
      <View style={styles.emptyContainer}>
        <Text style={styles.emptyText}>
          {diffMode === "uncommitted" ? "No uncommitted changes" : `No changes vs ${baseRefLabel}`}
        </Text>
      </View>
    );
  } else {
    bodyContent = (
      <FlatList
        ref={diffListRef}
        data={flatItems}
        renderItem={renderFlatItem}
        keyExtractor={flatKeyExtractor}
        stickyHeaderIndices={stickyHeaderIndices}
        extraData={expandedByPath}
        style={styles.scrollView}
        contentContainerStyle={styles.contentContainer}
        testID="git-diff-scroll"
        onLayout={handleDiffListLayout}
        onScroll={handleDiffListScroll}
        scrollEventThrottle={16}
        onRefresh={handleRefresh}
        refreshing={isManualRefresh && isDiffFetching}
        // Mixed-height rows (header + potentially very large body) are prone to clipping artifacts.
        // Keep a larger render window and disable clipping to avoid bodies disappearing mid-scroll.
        removeClippedSubviews={false}
        initialNumToRender={12}
        maxToRenderPerBatch={12}
        windowSize={10}
      />
    );
  }

  const hasPullRequest = Boolean(prStatus?.url);
  const hasRemote = gitStatus?.hasRemote ?? false;
  const isPaseoOwnedWorktree = gitStatus?.isPaseoOwnedWorktree ?? false;
  const currentBranch = gitStatus?.currentBranch;
  const isOnBaseBranch = currentBranch === baseRefLabel;

  // ==========================================================================
  // Git Actions (Data-Oriented)
  // ==========================================================================
  // All possible actions are computed as data, then partitioned into:
  // - primary: The main CTA button
  // - secondary: Dropdown next to primary button
  // - menu: Kebab overflow menu
  // ==========================================================================

  const gitActions: GitActions = useMemo(() => {
    if (!isGit) {
      return { primary: null, secondary: [], menu: [] };
    }

    // Build all possible actions
    const allActions = new Map<GitActionId, GitAction>();

    // Commit - always available
    allActions.set("commit", {
      id: "commit",
      label: "Commit",
      pendingLabel: "Committing...",
      successLabel: "Committed",
      disabled: commitDisabled,
      status: commitStatus,
      icon: <GitCommitHorizontal size={16} color={theme.colors.foregroundMuted} />,
      handler: handleCommit,
    });

    // Push - when has remote
    if (hasRemote) {
      allActions.set("push", {
        id: "push",
        label: "Push",
        pendingLabel: "Pushing...",
        successLabel: "Pushed",
        disabled: pushDisabled,
        status: pushStatus,
        description: !hasRemote ? "No remote configured" : undefined,
        icon: <Upload size={16} color={theme.colors.foregroundMuted} />,
        handler: handlePush,
      });
    }

    // View PR - when PR exists
    if (githubFeaturesEnabled && hasPullRequest && prStatus?.url) {
      const prUrl = prStatus.url;
      allActions.set("view-pr", {
        id: "view-pr",
        label: "View PR",
        pendingLabel: "View PR",
        successLabel: "View PR",
        disabled: false,
        status: "idle",
        icon: <GitHubIcon size={16} color={theme.colors.foregroundMuted} />,
        handler: () => openURLInNewTab(prUrl),
      });
    }

    // Create PR - when ahead of base and no PR
    if (githubFeaturesEnabled && aheadCount > 0 && !hasPullRequest) {
      allActions.set("create-pr", {
        id: "create-pr",
        label: "Create PR",
        pendingLabel: "Creating PR...",
        successLabel: "PR Created",
        disabled: prDisabled,
        status: prCreateStatus,
        icon: <GitHubIcon size={16} color={theme.colors.foregroundMuted} />,
        handler: handleCreatePr,
      });
    }

    // Merge branch - when ahead of base
    if (aheadCount > 0) {
      allActions.set("merge-branch", {
        id: "merge-branch",
        label: `Merge into ${baseRefLabel}`,
        pendingLabel: "Merging...",
        successLabel: "Merged",
        disabled: mergeDisabled,
        status: mergeStatus,
        description: hasUncommittedChanges ? "Requires clean working tree" : undefined,
        icon: <GitMerge size={16} color={theme.colors.foregroundMuted} />,
        handler: handleMergeBranch,
      });
    }

    // Update from base - only when not on base branch
    if (!isOnBaseBranch) {
      allActions.set("merge-from-base", {
        id: "merge-from-base",
        label: `Update from ${baseRefLabel}`,
        pendingLabel: "Updating...",
        successLabel: "Updated",
        disabled: mergeFromBaseDisabled,
        status: mergeFromBaseStatus,
        description: hasUncommittedChanges ? "Requires clean working tree" : undefined,
        icon: <RefreshCcw size={16} color={theme.colors.foregroundMuted} />,
        handler: handleMergeFromBase,
      });
    }

    // Archive worktree - only for Paseo worktrees
    if (isPaseoOwnedWorktree) {
      allActions.set("archive-worktree", {
        id: "archive-worktree",
        label: "Archive worktree",
        pendingLabel: "Archiving...",
        successLabel: "Archived",
        disabled: archiveDisabled,
        status: archiveStatus,
        icon: <Archive size={16} color={theme.colors.foregroundMuted} />,
        handler: handleArchiveWorktree,
      });
    }

    // Select primary action (priority rules)
    let primaryActionId: GitActionId | null = null;

    // Rule 1: Uncommitted changes → Commit
    if (hasUncommittedChanges) {
      primaryActionId = "commit";
    }
    // Rule 2: Ahead of origin → Push
    else if (aheadOfOrigin > 0 && allActions.has("push")) {
      primaryActionId = "push";
    }
    // Rule 3: Has PR → View PR
    else if (hasPullRequest) {
      primaryActionId = "view-pr";
    }
    // Rule 4: Ahead of base → Ship action based on preference
    else if (aheadCount > 0) {
      const preferred: GitActionId = shipDefault === "merge" ? "merge-branch" : "create-pr";
      const fallback: GitActionId = shipDefault === "merge" ? "create-pr" : "merge-branch";

      const preferredAction = allActions.get(preferred);
      const fallbackAction = allActions.get(fallback);

      if (preferredAction && !preferredAction.disabled) {
        primaryActionId = preferred;
      } else if (fallbackAction && !fallbackAction.disabled) {
        primaryActionId = fallback;
      } else if (preferredAction) {
        primaryActionId = preferred;
      }
    }

    const primary = primaryActionId ? allActions.get(primaryActionId) ?? null : null;

    // Secondary actions: ship-related + merge from base + push (excluding primary)
    const secondaryIds: GitActionId[] = ["merge-branch", "create-pr", "view-pr", "merge-from-base", "push"];
    const secondary = secondaryIds
      .filter(id => id !== primaryActionId && allActions.has(id))
      .map(id => allActions.get(id)!);

    // Menu actions: archive worktree only
    const menu = allActions.has("archive-worktree")
      ? [allActions.get("archive-worktree")!]
      : [];

    return { primary, secondary, menu };
  }, [
    isGit, hasRemote, hasPullRequest, prStatus?.url, aheadCount, isPaseoOwnedWorktree, isOnBaseBranch, githubFeaturesEnabled,
    hasUncommittedChanges, aheadOfOrigin, shipDefault, baseRefLabel,
    commitDisabled, pushDisabled, prDisabled, mergeDisabled, mergeFromBaseDisabled, archiveDisabled,
    commitStatus, pushStatus, prCreateStatus, mergeStatus, mergeFromBaseStatus, archiveStatus,
    handleCommit, handlePush, handleCreatePr, handleMergeBranch, handleMergeFromBase, handleArchiveWorktree,
    theme.colors.foregroundMuted,
  ]);

  // Helper to get display label based on status
  const getActionDisplayLabel = useCallback((action: GitAction): string => {
    if (action.status === "pending") return action.pendingLabel;
    if (action.status === "success") return action.successLabel;
    return action.label;
  }, []);

  return (
    <View style={styles.container}>
      <View style={styles.header} testID="changes-header">
        <View style={styles.headerLeft}>
          <GitBranch size={16} color={theme.colors.foregroundMuted} />
          <Text style={styles.branchLabel} testID="changes-branch" numberOfLines={1}>
            {branchLabel}
          </Text>
          {isStatusFetching && (
            <ActivityIndicator size="small" color={theme.colors.foregroundMuted} />
          )}
        </View>
        {isGit ? (
          <View style={styles.headerRight}>
            {gitActions.primary ? (
              <View style={styles.splitButton}>
                <Pressable
                  testID="changes-primary-cta"
                  style={[
                    styles.splitButtonPrimary,
                    gitActions.primary.disabled && styles.splitButtonPrimaryDisabled,
                  ]}
                  onPress={gitActions.primary.handler}
                  disabled={gitActions.primary.disabled}
                  accessibilityRole="button"
                  accessibilityLabel={gitActions.primary.label}
                >
                  {gitActions.primary.status === "pending" ? (
                    <ActivityIndicator
                      size="small"
                      color={theme.colors.foreground}
                      style={styles.splitButtonSpinnerOnly}
                    />
                  ) : (
                    <View style={styles.splitButtonContent}>
                      {gitActions.primary.icon}
                      <Text style={styles.splitButtonText}>{getActionDisplayLabel(gitActions.primary)}</Text>
                    </View>
                  )}
                </Pressable>
                {gitActions.secondary.length > 0 ? (
                  <DropdownMenu>
                    <DropdownMenuTrigger
                      testID="changes-primary-cta-caret"
                      style={styles.splitButtonCaret}
                      accessibilityRole="button"
                      accessibilityLabel="More options"
                    >
                      <ChevronDown size={16} color={theme.colors.foregroundMuted} />
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" testID="changes-primary-cta-menu">
                      {gitActions.secondary.map((action, index) => {
                        const needsSeparator = action.id === "merge-from-base" || action.id === "push";
                        return (
                          <View key={action.id}>
                            {needsSeparator && index > 0 ? <DropdownMenuSeparator /> : null}
                            <DropdownMenuItem
                              testID={`changes-menu-${action.id}`}
                              leading={action.icon}
                              disabled={action.disabled}
                              status={action.status}
                              pendingLabel={action.pendingLabel}
                              successLabel={action.successLabel}
                              closeOnSelect={action.status === "idle" && action.id === "view-pr"}
                              description={action.description}
                              onSelect={action.handler}
                            >
                              {action.label}
                            </DropdownMenuItem>
                          </View>
                        );
                      })}
                    </DropdownMenuContent>
                  </DropdownMenu>
                ) : null}
              </View>
            ) : null}
            {gitActions.menu.length > 0 ? (
              <DropdownMenu>
                <DropdownMenuTrigger
                  testID="changes-overflow-menu"
                  hitSlop={8}
                  style={[styles.iconButton, styles.overflowMenuButton]}
                  accessibilityRole="button"
                  accessibilityLabel="More actions"
                >
                  <MoreVertical size={16} color={theme.colors.foregroundMuted} />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" width={220} testID="changes-overflow-content">
                  {gitActions.menu.map((action) => (
                    <DropdownMenuItem
                      key={action.id}
                      testID={`changes-menu-${action.id}`}
                      leading={action.icon}
                      disabled={action.disabled}
                      status={action.status}
                      pendingLabel={action.pendingLabel}
                      successLabel={action.successLabel}
                      closeOnSelect={false}
                      onSelect={action.handler}
                    >
                      {action.label}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            ) : null}
          </View>
        ) : null}
      </View>

      {isGit ? (
        <View style={styles.diffStatusContainer}>
          <View style={styles.diffStatusInner}>
            <DropdownMenu>
              <DropdownMenuTrigger
                style={({ hovered, pressed, open }) => [
                  styles.diffModeTrigger,
                  hovered && styles.diffModeTriggerHovered,
                  (pressed || open) && styles.diffModeTriggerPressed,
                ]}
                testID="changes-diff-status"
                accessibilityRole="button"
                accessibilityLabel="Diff mode"
              >
                <Text style={styles.diffStatusText}>
                  {diffMode === "uncommitted" ? "Uncommitted" : "Committed"}
                </Text>
                <ChevronDown size={12} color={theme.colors.foregroundMuted} />
              </DropdownMenuTrigger>
              <DropdownMenuContent
                align="start"
                width={260}
                testID="changes-diff-status-menu"
              >
                <DropdownMenuItem
                  testID="changes-diff-mode-uncommitted"
                  selected={diffMode === "uncommitted"}
                  onSelect={() => setDiffModeOverride("uncommitted")}
                >
                  Uncommitted
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  testID="changes-diff-mode-committed"
                  selected={diffMode === "base"}
                  description={committedDiffDescription}
                  onSelect={() => setDiffModeOverride("base")}
                >
                  Committed
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            {files.length > 0 ? (
              <Pressable
                style={({ hovered, pressed }) => [
                  styles.expandAllButton,
                  (hovered || pressed) && styles.diffStatusRowHovered,
                ]}
                onPress={handleToggleExpandAll}
              >
                {allExpanded ? (
                  <ListChevronsDownUp size={14} color={theme.colors.foregroundMuted} />
                ) : (
                  <ListChevronsUpDown size={14} color={theme.colors.foregroundMuted} />
                )}
              </Pressable>
            ) : null}
          </View>
        </View>
      ) : null}

      {actionError ? <Text style={styles.actionErrorText}>{actionError}</Text> : null}
      {prErrorMessage ? (
        <Text style={styles.actionErrorText}>{prErrorMessage}</Text>
      ) : null}

      <View style={styles.diffContainer}>{bodyContent}</View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
    minHeight: 0,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
  },
  headerLeft: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    flex: 1,
    minWidth: 0,
  },
  headerRight: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    flexShrink: 0,
  },
  branchLabel: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foreground,
    fontWeight: theme.fontWeight.medium,
    flexShrink: 1,
  },
  diffStatusContainer: {
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
  },
  diffStatusInner: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingRight: theme.spacing[3],
  },
  diffModeTrigger: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    // Align text with header branch icon (at spacing[3] from edge, minus our horizontal padding)
    marginLeft: theme.spacing[3] - theme.spacing[1],
    marginVertical: theme.spacing[2],
    paddingHorizontal: theme.spacing[1],
    paddingVertical: theme.spacing[1],
    borderRadius: theme.borderRadius.base,
  },
  diffModeTriggerHovered: {
    backgroundColor: theme.colors.surface2,
  },
  diffModeTriggerPressed: {
    backgroundColor: theme.colors.surface2,
  },
  diffStatusRowHovered: {
    backgroundColor: theme.colors.surface2,
  },
  diffStatusText: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
  },
  diffStatusIconHidden: {
    opacity: 0,
  },
  expandAllButton: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    marginVertical: theme.spacing[2],
    paddingHorizontal: theme.spacing[1],
    paddingVertical: theme.spacing[1],
    borderRadius: theme.borderRadius.base,
  },
  splitButton: {
    flexDirection: "row",
    alignItems: "stretch",
    borderRadius: theme.borderRadius.md,
    backgroundColor: theme.colors.surface2,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.borderAccent,
    overflow: "hidden",
  },
  splitButtonPrimary: {
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[1],
    justifyContent: "center",
    position: "relative",
  },
  splitButtonPrimaryDisabled: {
    opacity: 0.6,
  },
  splitButtonText: {
    fontSize: theme.fontSize.sm,
    lineHeight: theme.fontSize.sm * 1.5,
    color: theme.colors.foreground,
    fontWeight: theme.fontWeight.medium,
  },
  splitButtonContent: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: theme.spacing[2],
  },
  splitButtonSpinnerOnly: {
    transform: [{ scale: 0.8 }],
  },
  splitButtonCaret: {
    width: 36,
    alignItems: "center",
    justifyContent: "center",
    borderLeftWidth: theme.borderWidth[1],
    borderLeftColor: theme.colors.borderAccent,
  },
  iconButton: {
    width: 32,
    height: 32,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: theme.borderRadius.md,
  },
  overflowMenuButton: {
    marginRight: -theme.spacing[2],
  },
  menuOverlay: {
    flex: 1,
  },
  menuBackdrop: {
    position: "absolute",
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
  },
  dropdownMenu: {
    backgroundColor: theme.colors.surface0,
    borderWidth: 1,
    borderColor: theme.colors.borderAccent,
    borderRadius: theme.borderRadius.lg,
    overflow: "hidden",
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.2,
    shadowRadius: 8,
    elevation: 8,
  },
  menuItem: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
  },
  menuItemSelected: {
    backgroundColor: theme.colors.surface2,
  },
  menuItemDisabled: {
    opacity: 0.5,
  },
  menuItemText: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foreground,
    fontWeight: theme.fontWeight.medium,
  },
  menuHintText: {
    paddingHorizontal: theme.spacing[3],
    paddingBottom: theme.spacing[2],
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
  },
  menuItemDestructive: {
    backgroundColor: "rgba(248, 81, 73, 0.08)",
  },
  menuItemTextDestructive: {
    color: theme.colors.destructive,
  },
  menuDivider: {
    height: 1,
    backgroundColor: theme.colors.border,
  },
  actionErrorText: {
    paddingHorizontal: theme.spacing[3],
    paddingBottom: theme.spacing[1],
    fontSize: theme.fontSize.xs,
    color: theme.colors.destructive,
  },
  diffContainer: {
    flex: 1,
    minHeight: 0,
  },
  scrollView: {
    flex: 1,
  },
  contentContainer: {
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
    overflow: "hidden",
    backgroundColor: theme.colors.surface2,
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
  },
  fileSectionHeaderContainer: {
    overflow: "hidden",
    backgroundColor: theme.colors.surface1,
  },
  fileSectionBodyContainer: {
    overflow: "hidden",
    backgroundColor: theme.colors.surface2,
  },
  fileSectionBorder: {
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
  },
  fileHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingLeft: theme.spacing[3],
    paddingRight: theme.spacing[2],
    paddingVertical: theme.spacing[2],
    gap: theme.spacing[1],
    backgroundColor: theme.colors.surface1,
    zIndex: 2,
    elevation: 2,
  },
  fileHeaderPressed: {
    opacity: 0.7,
  },
  fileHeaderLeft: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    flex: 1,
    minWidth: 0,
  },
  fileHeaderRight: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    flexShrink: 0,
  },
  fileName: {
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.normal,
    color: theme.colors.foreground,
    flexShrink: 0,
  },
  fileDir: {
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.normal,
    color: theme.colors.foregroundMuted,
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
  deletedBadge: {
    backgroundColor: "rgba(248, 81, 73, 0.2)",
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1],
    borderRadius: theme.borderRadius.md,
    flexShrink: 0,
  },
  deletedBadgeText: {
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.normal,
    color: theme.colors.palette.red[500],
  },
  additions: {
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.normal,
    color: theme.colors.palette.green[400],
  },
  deletions: {
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.normal,
    color: theme.colors.palette.red[500],
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
  statusMessageContainer: {
    borderTopWidth: theme.borderWidth[1],
    borderTopColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[4],
  },
  statusMessageText: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
    fontStyle: "italic",
  },
}));
