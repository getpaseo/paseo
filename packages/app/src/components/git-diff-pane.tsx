import { useState, useCallback, useEffect, useId, useMemo, useRef, memo, type ReactElement } from "react";
import type { UseMutationResult } from "@tanstack/react-query";
import { useRouter } from "expo-router";
import {
  View,
  Text,
  ActivityIndicator,
  Pressable,
  FlatList,
  Platform,
  type NativeSyntheticEvent,
  type NativeScrollEvent,
  type ListRenderItem,
} from "react-native";
import { ScrollView, type ScrollView as ScrollViewType } from "react-native-gesture-handler";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import AsyncStorage from "@react-native-async-storage/async-storage";
import * as Linking from "expo-linking";
import { ChevronDown, ChevronRight, GitBranch, MoreVertical } from "lucide-react-native";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useSessionStore } from "@/stores/session-store";
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  type ActionStatus,
} from "@/components/ui/dropdown-menu";

// =============================================================================
// Action Status Hook
// =============================================================================
// Tracks mutation state with a brief success phase before returning to idle.
// State flow: idle → pending → success (1s) → idle
// =============================================================================

const SUCCESS_DISPLAY_MS = 1000;

type ActionState = {
  status: ActionStatus;
  trigger: () => void;
};

function useActionStatus<TData, TError, TVariables, TContext>(
  mutation: UseMutationResult<TData, TError, TVariables, TContext>,
  onTrigger?: () => void
): ActionState {
  const [showSuccess, setShowSuccess] = useState(false);
  const successTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Clear timeout on unmount
  useEffect(() => {
    return () => {
      if (successTimeoutRef.current) {
        clearTimeout(successTimeoutRef.current);
      }
    };
  }, []);

  // Watch for mutation success to trigger success display
  useEffect(() => {
    if (mutation.isSuccess && !mutation.isPending) {
      setShowSuccess(true);
      successTimeoutRef.current = setTimeout(() => {
        setShowSuccess(false);
        mutation.reset();
      }, SUCCESS_DISPLAY_MS);
    }
  }, [mutation.isSuccess, mutation.isPending, mutation]);

  const status: ActionStatus = mutation.isPending
    ? "pending"
    : showSuccess
      ? "success"
      : "idle";

  const trigger = useCallback(() => {
    onTrigger?.();
    mutation.mutate(undefined as TVariables);
  }, [mutation, onTrigger]);

  return { status, trigger };
}

function openURLInNewTab(url: string): void {
  if (Platform.OS === "web") {
    window.open(url, "_blank", "noopener");
  } else {
    void Linking.openURL(url);
  }
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
        testID={testID ? `${testID}-toggle` : undefined}
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
      {isExpanded && (file.status === "too_large" || file.status === "binary") ? (
        <View style={styles.statusMessageContainer}>
          <Text style={styles.statusMessageText}>
            {file.status === "binary" ? "Binary file" : "Diff too large to display"}
          </Text>
        </View>
      ) : isExpanded ? (
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
      ) : null}
    </View>
  );
});

interface GitDiffPaneProps {
  serverId: string;
  agentId: string;
  cwd: string;
}

export function GitDiffPane({ serverId, agentId, cwd }: GitDiffPaneProps) {
  const { theme } = useUnistyles();
  const router = useRouter();
  const queryClient = useQueryClient();
  const client = useSessionStore(
    (state) => state.sessions[serverId]?.client ?? null
  );
  const [diffModeOverride, setDiffModeOverride] = useState<"uncommitted" | "base" | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [shipDefault, setShipDefault] = useState<"merge" | "pr">("merge");
  const { status, isLoading: isStatusLoading, isFetching: isStatusFetching, isError: isStatusError, error: statusError, refresh: refreshStatus } =
    useCheckoutStatusQuery({ serverId, agentId, cwd });
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
    agentId,
    mode: diffMode,
    baseRef,
    enabled: isGit,
  });
  const {
    status: prStatus,
    payloadError: prPayloadError,
    refresh: refreshPrStatus,
  } = useCheckoutPrStatusQuery({
    serverId,
    agentId,
    enabled: isGit,
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

  const handleToggleExpanded = useCallback((path: string) => {
    setExpandedByPath((prev) => ({
      ...prev,
      [path]: !prev[path],
    }));
  }, []);

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

  const agentExists = useSessionStore((state) =>
    state.sessions[serverId]?.agents?.has(agentId) ?? false
  );

  const commitMutation = useMutation({
    mutationFn: async () => {
      if (!client) {
        throw new Error("Daemon client unavailable");
      }
      const payload = await client.checkoutCommit(agentId, { addAll: true });
      if (payload.error) {
        throw new Error(payload.error.message);
      }
      return payload;
    },
    onSuccess: () => {
      setActionError(null);
      void refreshDiff();
      void refreshStatus();
    },
    onError: (err) => {
      const message = err instanceof Error ? err.message : "Failed to commit";
      setActionError(message);
    },
  });

  const prMutation = useMutation({
    mutationFn: async () => {
      if (!client) {
        throw new Error("Daemon client unavailable");
      }
      const payload = await client.checkoutPrCreate(agentId, {});
      if (payload.error) {
        throw new Error(payload.error.message);
      }
      return payload;
    },
    onSuccess: () => {
      setActionError(null);
      void refreshPrStatus();
    },
    onError: (err) => {
      const message = err instanceof Error ? err.message : "Failed to create PR";
      setActionError(message);
    },
  });

  const mergeMutation = useMutation({
    mutationFn: async () => {
      if (!client) {
        throw new Error("Daemon client unavailable");
      }
      const payload = await client.checkoutMerge(agentId, {
        baseRef,
        strategy: "merge",
        requireCleanTarget: true,
      });
      if (payload.error) {
        throw new Error(payload.error.message);
      }
      return payload;
    },
    onSuccess: () => {
      setActionError(null);
      void refreshDiff();
      void refreshStatus();
    },
    onError: (err) => {
      const message = err instanceof Error ? err.message : "Failed to merge";
      setActionError(message);
    },
  });

  const mergeFromBaseMutation = useMutation({
    mutationFn: async () => {
      if (!client) {
        throw new Error("Daemon client unavailable");
      }
      const payload = await client.checkoutMergeFromBase(agentId, {
        baseRef,
        requireCleanTarget: true,
      });
      if (payload.error) {
        throw new Error(payload.error.message);
      }
      return payload;
    },
    onSuccess: () => {
      setActionError(null);
      void refreshDiff();
      void refreshStatus();
    },
    onError: (err) => {
      const message = err instanceof Error ? err.message : "Failed to merge from base";
      setActionError(message);
    },
  });

  const pushMutation = useMutation({
    mutationFn: async () => {
      if (!client) {
        throw new Error("Daemon client unavailable");
      }
      const payload = await client.checkoutPush(agentId);
      if (payload.error) {
        throw new Error(payload.error.message);
      }
      return payload;
    },
    onSuccess: () => {
      setActionError(null);
      void refreshStatus();
    },
    onError: (err) => {
      const message = err instanceof Error ? err.message : "Failed to push";
      setActionError(message);
    },
  });

  const archiveMutation = useMutation({
    mutationFn: async () => {
      if (!client) {
        throw new Error("Daemon client unavailable");
      }
      const worktreePath = status?.cwd;
      if (!worktreePath) {
        throw new Error("Worktree path unavailable");
      }
      const payload = await client.archivePaseoWorktree({ worktreePath });
      if (payload.error) {
        throw new Error(payload.error.message);
      }
      return payload;
    },
    onSuccess: () => {
      setActionError(null);
      queryClient.invalidateQueries({
        predicate: (query) =>
          Array.isArray(query.queryKey) && query.queryKey[0] === "paseoWorktreeList",
      });
      router.replace("/agent" as any);
    },
    onError: (err) => {
      const message = err instanceof Error ? err.message : "Failed to archive worktree";
      setActionError(message);
    },
  });

  // Wrap mutations with action status for UI feedback
  const commitAction = useActionStatus(commitMutation);
  const prCreateAction = useActionStatus(prMutation, () => void persistShipDefault("pr"));
  const mergeAction = useActionStatus(mergeMutation, () => void persistShipDefault("merge"));
  const mergeFromBaseAction = useActionStatus(mergeFromBaseMutation);
  const pushAction = useActionStatus(pushMutation);
  const archiveAction = useActionStatus(archiveMutation);

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
  const diffErrorMessage =
    diffPayloadError?.message ??
    (isDiffError && diffError instanceof Error ? diffError.message : null);
  const prErrorMessage = prPayloadError?.message ?? null;
  const branchLabel =
    gitStatus?.currentBranch ?? (notGit ? "Not a git repository" : "Unknown");
  const actionsDisabled = !isGit || Boolean(status?.error) || isStatusLoading;
  const aheadCount = gitStatus?.aheadBehind?.ahead ?? 0;
  const baseRefLabel = useMemo(() => {
    if (!baseRef) return "base";
    const trimmed = baseRef.replace(/^refs\/(heads|remotes)\//, "").trim();
    return trimmed.startsWith("origin/") ? trimmed.slice("origin/".length) : trimmed;
  }, [baseRef]);
  const commitDisabled = actionsDisabled || commitMutation.isPending;
  const prDisabled = actionsDisabled || prMutation.isPending;
  const mergeDisabled = actionsDisabled || mergeMutation.isPending || hasUncommittedChanges;
  const mergeFromBaseDisabled =
    actionsDisabled || mergeFromBaseMutation.isPending || hasUncommittedChanges;
  const pushDisabled =
    actionsDisabled || pushMutation.isPending || !(gitStatus?.hasRemote ?? false);
  const archiveDisabled =
    actionsDisabled ||
    archiveMutation.isPending ||
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
        data={files}
        renderItem={renderFileSection}
        keyExtractor={keyExtractor}
        extraData={expandedByPath}
        style={styles.scrollView}
        contentContainerStyle={styles.contentContainer}
        testID="git-diff-scroll"
        onRefresh={handleRefresh}
        refreshing={isManualRefresh && isDiffFetching}
        initialNumToRender={3}
        maxToRenderPerBatch={3}
        windowSize={5}
      />
    );
  }

  const hasPullRequest = Boolean(prStatus?.url);

  // ==========================================================================
  // Primary CTA Logic
  // ==========================================================================
  // Rules (in priority order):
  // 1. Uncommitted changes → "Commit" is primary
  // 2. Has PR → "View PR" is primary
  // 3. Ahead of base → "Merge branch" or "Create PR" based on shipDefault preference
  // 4. Nothing to do → no primary CTA
  // ==========================================================================

  type PrimaryCTA =
    | { type: "commit" }
    | { type: "view-pr"; url: string }
    | { type: "ship"; action: "merge" | "create-pr" }
    | null;

  const primaryCTA: PrimaryCTA = useMemo(() => {
    if (!isGit) return null;

    // Rule 1: Uncommitted changes → Commit
    if (hasUncommittedChanges) {
      return { type: "commit" };
    }

    // Rule 2: Has PR → View PR
    if (hasPullRequest && prStatus?.url) {
      return { type: "view-pr", url: prStatus.url };
    }

    // Rule 3: Ahead of base → Ship (merge or create PR based on preference)
    if (aheadCount > 0) {
      const preferredAction = shipDefault === "merge" ? "merge" : "create-pr";
      // If preferred action is disabled, fall back to the other
      if (preferredAction === "merge" && mergeDisabled && !prDisabled) {
        return { type: "ship", action: "create-pr" };
      }
      if (preferredAction === "create-pr" && prDisabled && !mergeDisabled) {
        return { type: "ship", action: "merge" };
      }
      return { type: "ship", action: preferredAction };
    }

    // Rule 4: Nothing to do
    return null;
  }, [isGit, hasUncommittedChanges, hasPullRequest, prStatus?.url, aheadCount, shipDefault, mergeDisabled, prDisabled]);

  const primaryCTALabel = useMemo(() => {
    if (!primaryCTA) return "";
    switch (primaryCTA.type) {
      case "commit":
        return "Commit";
      case "view-pr":
        return "View PR";
      case "ship":
        return primaryCTA.action === "merge" ? "Merge branch" : "Create PR";
    }
  }, [primaryCTA]);

  const primaryCTADisabled = useMemo(() => {
    if (!primaryCTA || actionsDisabled) return true;
    switch (primaryCTA.type) {
      case "commit":
        return commitDisabled;
      case "view-pr":
        return false; // View PR is never disabled
      case "ship":
        return primaryCTA.action === "merge" ? mergeDisabled : prDisabled;
    }
  }, [primaryCTA, actionsDisabled, commitDisabled, mergeDisabled, prDisabled]);

  const primaryCTAStatus: ActionStatus = useMemo(() => {
    if (!primaryCTA) return "idle";
    switch (primaryCTA.type) {
      case "commit":
        return commitAction.status;
      case "view-pr":
        return "idle"; // View PR is instant, no status
      case "ship":
        return primaryCTA.action === "merge" ? mergeAction.status : prCreateAction.status;
    }
  }, [primaryCTA, commitAction.status, mergeAction.status, prCreateAction.status]);

  const primaryCTADisplayLabel = useMemo(() => {
    if (!primaryCTA) return "";
    const status = primaryCTAStatus;

    switch (primaryCTA.type) {
      case "commit":
        if (status === "pending") return "Committing...";
        if (status === "success") return "Committed";
        return "Commit";
      case "view-pr":
        return "View PR";
      case "ship":
        if (primaryCTA.action === "merge") {
          if (status === "pending") return "Merging...";
          if (status === "success") return "Merged";
          return "Merge branch";
        } else {
          if (status === "pending") return "Creating PR...";
          if (status === "success") return "PR Created";
          return "Create PR";
        }
    }
  }, [primaryCTA, primaryCTAStatus]);

  const handlePrimaryCTAPress = useCallback(() => {
    if (!primaryCTA || primaryCTADisabled || primaryCTAStatus !== "idle") return;
    switch (primaryCTA.type) {
      case "commit":
        commitAction.trigger();
        break;
      case "view-pr":
        openURLInNewTab(primaryCTA.url);
        break;
      case "ship":
        if (primaryCTA.action === "merge") {
          mergeAction.trigger();
        } else {
          prCreateAction.trigger();
        }
        break;
    }
  }, [primaryCTA, primaryCTADisabled, primaryCTAStatus, commitAction, mergeAction, prCreateAction]);

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
            {primaryCTA ? (
              <View style={styles.splitButton}>
                <Pressable
                  testID="changes-primary-cta"
                  style={[
                    styles.splitButtonPrimary,
                    primaryCTADisabled && styles.splitButtonPrimaryDisabled,
                  ]}
                  onPress={handlePrimaryCTAPress}
                  disabled={primaryCTADisabled}
                  accessibilityRole="button"
                  accessibilityLabel={primaryCTALabel}
                >
                  {primaryCTAStatus === "pending" ? (
                    <ActivityIndicator size="small" color={theme.colors.foreground} style={styles.splitButtonSpinner} />
                  ) : (
                    <Text style={styles.splitButtonText}>{primaryCTADisplayLabel}</Text>
                  )}
                </Pressable>
                <DropdownMenu>
                  <DropdownMenuTrigger
                    testID="changes-primary-cta-caret"
                    style={styles.splitButtonCaret}
                    accessibilityRole="button"
                    accessibilityLabel="More options"
                  >
                    <ChevronDown size={16} color={theme.colors.foregroundMuted} />
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" width={260} testID="changes-primary-cta-menu">
                    {/* Ship actions - only show if ahead of base */}
                    {aheadCount > 0 ? (
                      <>
                        <DropdownMenuItem
                          testID="changes-menu-merge"
                          disabled={mergeDisabled}
                          status={mergeAction.status}
                          pendingLabel="Merging..."
                          successLabel="Merged"
                          closeOnSelect={false}
                          description={hasUncommittedChanges ? "Requires clean working tree" : undefined}
                          onSelect={mergeAction.trigger}
                        >
                          Merge branch
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          testID={hasPullRequest ? "changes-menu-view-pr" : "changes-menu-create-pr"}
                          disabled={!hasPullRequest && prDisabled}
                          status={!hasPullRequest ? prCreateAction.status : undefined}
                          pendingLabel="Creating PR..."
                          successLabel="PR Created"
                          closeOnSelect={!hasPullRequest ? false : true}
                          onSelect={() => {
                            if (hasPullRequest && prStatus?.url) {
                              openURLInNewTab(prStatus.url);
                              return;
                            }
                            prCreateAction.trigger();
                          }}
                        >
                          {hasPullRequest ? "View PR" : "Create PR"}
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
                      </>
                    ) : null}
                    <DropdownMenuItem
                      testID="changes-menu-merge-from-base"
                      disabled={mergeFromBaseDisabled}
                      status={mergeFromBaseAction.status}
                      pendingLabel="Merging..."
                      successLabel="Merged"
                      closeOnSelect={false}
                      description={hasUncommittedChanges ? "Requires clean working tree" : undefined}
                      onSelect={mergeFromBaseAction.trigger}
                    >
                      Merge from {baseRefLabel}
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      testID="changes-menu-push"
                      disabled={pushDisabled}
                      status={pushAction.status}
                      pendingLabel="Pushing..."
                      successLabel="Pushed"
                      closeOnSelect={false}
                      description={!(gitStatus?.hasRemote ?? false) ? "No remote configured" : undefined}
                      onSelect={pushAction.trigger}
                    >
                      Push to remote
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </View>
            ) : null}
            <DropdownMenu>
              <DropdownMenuTrigger
                testID="changes-overflow-menu"
                hitSlop={8}
                style={styles.iconButton}
                accessibilityRole="button"
                accessibilityLabel="More actions"
              >
                <MoreVertical size={16} color={theme.colors.foregroundMuted} />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" width={220} testID="changes-overflow-content">
                <DropdownMenuItem
                  testID="changes-menu-toggle-view"
                  onSelect={() => setDiffModeOverride(diffMode === "uncommitted" ? "base" : "uncommitted")}
                >
                  {diffMode === "uncommitted" ? `Show changes vs ${baseRefLabel}` : "Show uncommitted changes"}
                </DropdownMenuItem>
                {gitStatus?.isPaseoOwnedWorktree ? (
                  <>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      testID="changes-menu-archive"
                      destructive
                      disabled={archiveDisabled}
                      status={archiveAction.status}
                      pendingLabel="Archiving..."
                      successLabel="Archived"
                      closeOnSelect={false}
                      onSelect={archiveAction.trigger}
                    >
                      Archive worktree
                    </DropdownMenuItem>
                  </>
                ) : null}
              </DropdownMenuContent>
            </DropdownMenu>
          </View>
        ) : null}
      </View>

      {isGit && hasChanges ? (
        <View style={styles.diffStatusRow} testID="changes-diff-status">
          <Text style={styles.diffStatusText}>
            {diffMode === "uncommitted" ? "Uncommitted changes" : `Changes vs ${baseRefLabel}`}
          </Text>
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
  diffStatusRow: {
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
  },
  diffStatusText: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
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
    paddingVertical: theme.spacing[2],
    justifyContent: "center",
  },
  splitButtonPrimaryDisabled: {
    opacity: 0.6,
  },
  splitButtonText: {
    fontSize: theme.fontSize.xs,
    lineHeight: theme.fontSize.xs * 1.5,
    color: theme.colors.foreground,
    fontWeight: theme.fontWeight.medium,
  },
  splitButtonSpinner: {
    height: theme.fontSize.xs * 1.5,
    width: theme.fontSize.xs * 1.5,
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
    borderBottomColor: theme.colors.borderAccent,
  },
  fileHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[2],
    gap: theme.spacing[1],
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
