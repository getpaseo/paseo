import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, ScrollView, Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { Check } from "lucide-react-native";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";
import { syntaxTokenStyleFor } from "@/styles/syntax-token-styles";
import { parseUnifiedDiff, type DiffLine } from "@/utils/tool-call-parsers";
import { diffLinePrefix, highlightDiffLines } from "@/utils/diff-highlight";
import {
  usePrReviewThreadsQuery,
  type PullRequestReviewThread,
} from "@/git/use-pr-review-threads-query";
import {
  buildReviewCommentsPrompt,
  formatReviewThreadLineRange,
} from "@/git/pr-review-comment-prompt";
import {
  isFileFullySelected,
  pruneSelectionToExisting,
  selectionsAreEqual,
  toggleFileSelection,
  toggleThreadSelection,
} from "@/git/pr-review-comment-selection";
import { resolveReviewCommentAgentId } from "@/git/pr-review-comment-dispatch";
import { reviewThreadsErrorMessageKey } from "@/git/pr-review-comment-error";

interface PrReviewCommentsProps {
  serverId: string;
  cwd: string;
  enabled?: boolean;
}

function stripDiffPrefix(line: DiffLine): string {
  const { type, content } = line;
  if (type === "add" || type === "remove") {
    return content.startsWith(type === "add" ? "+" : "-") ? content.slice(1) : content;
  }
  if (type === "context") {
    return content.startsWith(" ") ? content.slice(1) : content;
  }
  return content;
}

function diffPrefixStyle(type: DiffLine["type"]) {
  if (type === "add") return styles.diffAdd;
  if (type === "remove") return styles.diffRemove;
  return styles.diffMuted;
}

function threadRowPressableStyle({ hovered }: { hovered?: boolean }) {
  return [styles.threadRow, Boolean(hovered) && styles.hoverable];
}

function DiffHunkLine({ line }: { line: DiffLine }) {
  const prefix = diffLinePrefix(line);
  const code = stripDiffPrefix(line);
  const tokens = line.type !== "header" ? line.tokens : undefined;
  const keyedTokens = useMemo(
    () =>
      tokens && tokens.length > 0
        ? tokens.map((token, index) => ({ key: `${index}-${token.text}`, token }))
        : null,
    [tokens],
  );
  return (
    <Text style={styles.diffLine} numberOfLines={1}>
      {prefix ? <Text style={diffPrefixStyle(line.type)}>{prefix}</Text> : null}
      {keyedTokens ? (
        keyedTokens.map(({ key, token }) => (
          <Text key={key} style={syntaxTokenStyleFor(token.style)}>
            {token.text}
          </Text>
        ))
      ) : (
        <Text style={line.type === "header" ? styles.diffMuted : styles.diffCode}>{code}</Text>
      )}
    </Text>
  );
}

function ReviewDiffHunk({ diffHunk, path }: { diffHunk: string; path: string }) {
  const keyedLines = useMemo(() => {
    const lines = highlightDiffLines(parseUnifiedDiff(diffHunk), path);
    return lines.map((line, index) => ({ key: `${index}-${line.content}`, line }));
  }, [diffHunk, path]);
  if (keyedLines.length === 0) {
    return null;
  }
  return (
    <View style={styles.diffHunk}>
      {keyedLines.map(({ key, line }) => (
        <DiffHunkLine key={key} line={line} />
      ))}
    </View>
  );
}

function SelectionBox({ selected }: { selected: boolean }) {
  return (
    <View style={selected ? styles.checkboxSelected : styles.checkbox}>
      {selected ? <Check size={11} color={styles.checkIconColor.color} /> : null}
    </View>
  );
}

function ThreadRow({
  thread,
  selected,
  onToggle,
}: {
  thread: PullRequestReviewThread;
  selected: boolean;
  onToggle: (threadId: string) => void;
}) {
  const { t } = useTranslation();
  const lineRange = formatReviewThreadLineRange(thread);
  const reviewer = thread.comments[0]?.author ?? "unknown";
  const latest = thread.comments[thread.comments.length - 1];
  const replyCount = thread.comments.length;
  const handlePress = useCallback(() => onToggle(thread.id), [onToggle, thread.id]);
  return (
    <Pressable onPress={handlePress} style={threadRowPressableStyle} testID="pr-review-comment-row">
      <SelectionBox selected={selected} />
      <View style={styles.threadMain}>
        <View style={styles.threadHeader}>
          <Text style={styles.threadReviewer} numberOfLines={1}>
            {reviewer}
          </Text>
          {lineRange ? <Text style={styles.threadMeta}>{`L${lineRange}`}</Text> : null}
          {replyCount > 1 ? (
            <Text style={styles.threadMeta}>
              {t(
                replyCount === 1
                  ? "workspace.git.pr.reviewComments.replies"
                  : "workspace.git.pr.reviewComments.repliesPlural",
                { count: replyCount },
              )}
            </Text>
          ) : null}
        </View>
        <ReviewDiffHunk diffHunk={thread.diffHunk} path={thread.path} />
        <Text style={styles.threadBody} numberOfLines={4}>
          {latest?.body ?? ""}
        </Text>
      </View>
    </Pressable>
  );
}

function FileGroupHeader({
  path,
  threads,
  selected,
  onToggleFile,
}: {
  path: string;
  threads: PullRequestReviewThread[];
  selected: ReadonlySet<string>;
  onToggleFile: (threadIds: string[]) => void;
}) {
  const threadIds = useMemo(() => threads.map((thread) => thread.id), [threads]);
  const allSelected = isFileFullySelected(selected, threadIds);
  const handlePress = useCallback(() => onToggleFile(threadIds), [onToggleFile, threadIds]);
  return (
    <Pressable onPress={handlePress} style={styles.fileGroupHeader}>
      <SelectionBox selected={allSelected} />
      <Text style={styles.fileGroupPath} numberOfLines={1}>
        {path}
      </Text>
    </Pressable>
  );
}

// __MAIN__

export function PrReviewComments({ serverId, cwd, enabled = true }: PrReviewCommentsProps) {
  const { t } = useTranslation();
  const client = useHostRuntimeClient(serverId);
  const result = usePrReviewThreadsQuery({ serverId, cwd, enabled });
  const { threads, groups, capabilitySupported, isLoading, payloadError, error, refetch } = result;

  const agentId = useSessionStore((state) => {
    const session = state.sessions[serverId];
    return resolveReviewCommentAgentId({
      agents: session?.agents,
      focusedAgentId: session?.focusedAgentId ?? null,
      cwd,
    });
  });

  const threadIds = useMemo(() => threads.map((thread) => thread.id), [threads]);
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set<string>());
  const effectiveSelected = useMemo(
    () => pruneSelectionToExisting(selected, threadIds),
    [selected, threadIds],
  );
  useEffect(() => {
    if (!selectionsAreEqual(selected, effectiveSelected)) {
      setSelected(effectiveSelected);
    }
  }, [selected, effectiveSelected]);

  const handleToggleThread = useCallback((threadId: string) => {
    setSelected((prev) => toggleThreadSelection(prev, threadId));
  }, []);
  const handleToggleFile = useCallback((fileThreadIds: string[]) => {
    setSelected((prev) => toggleFileSelection(prev, fileThreadIds));
  }, []);

  const selectedThreads = useMemo(
    () => threads.filter((thread) => effectiveSelected.has(thread.id)),
    [threads, effectiveSelected],
  );

  const handleFix = useCallback(() => {
    if (!client || !agentId || selectedThreads.length === 0) {
      return;
    }
    const prompt = buildReviewCommentsPrompt(selectedThreads);
    void client.sendMessage(agentId, prompt).catch((sendError) => {
      console.error("[PrReviewComments] Failed to dispatch review comments:", sendError);
    });
    setSelected(new Set<string>());
  }, [client, agentId, selectedThreads]);

  let body: React.ReactNode;
  const errorKey = reviewThreadsErrorMessageKey(payloadError, error);
  if (!capabilitySupported) {
    body = (
      <Text style={styles.notice}>{t("workspace.git.pr.reviewComments.hostUpdateRequired")}</Text>
    );
  } else if (errorKey) {
    body = (
      <View style={styles.noticeBlock}>
        <Text style={styles.notice}>{t(errorKey)}</Text>
        <Pressable onPress={refetch} style={styles.retryButton} testID="pr-review-comment-retry">
          <Text style={styles.retryText}>{t("common.actions.retry")}</Text>
        </Pressable>
      </View>
    );
  } else if (isLoading) {
    body = <Text style={styles.notice}>{t("workspace.git.pr.reviewComments.loading")}</Text>;
  } else if (threads.length === 0) {
    body = <Text style={styles.notice}>{t("workspace.git.pr.reviewComments.empty")}</Text>;
  } else {
    body = (
      <ScrollView
        style={styles.list}
        contentContainerStyle={styles.listContent}
        showsVerticalScrollIndicator={false}
      >
        {groups.map((group) => (
          <View key={group.path}>
            <FileGroupHeader
              path={group.path}
              threads={group.threads}
              selected={effectiveSelected}
              onToggleFile={handleToggleFile}
            />
            {group.threads.map((thread) => (
              <ThreadRow
                key={thread.id}
                thread={thread}
                selected={effectiveSelected.has(thread.id)}
                onToggle={handleToggleThread}
              />
            ))}
          </View>
        ))}
      </ScrollView>
    );
  }

  const selectedCount = selectedThreads.length;
  const showActionBar = capabilitySupported && !errorKey && threads.length > 0;
  const dispatchDisabled = selectedCount === 0 || !agentId;
  const fixButtonStyle = useMemo(
    () => [styles.fixButton, dispatchDisabled && styles.fixButtonDisabled],
    [dispatchDisabled],
  );
  const fixTextStyle = useMemo(
    () => [styles.fixText, dispatchDisabled && styles.fixTextDisabled],
    [dispatchDisabled],
  );

  return (
    <View style={styles.root} testID="pr-review-comments">
      <View style={styles.divider} />
      <View style={styles.titleRow}>
        <Text style={styles.title}>{t("workspace.git.pr.reviewComments.title")}</Text>
      </View>
      {body}
      {showActionBar ? (
        <View style={styles.actionBar}>
          {selectedCount > 0 && !agentId ? (
            <Text style={styles.actionHint} numberOfLines={2}>
              {t("workspace.git.pr.reviewComments.noActiveAgent")}
            </Text>
          ) : null}
          <Pressable
            onPress={handleFix}
            disabled={dispatchDisabled}
            style={fixButtonStyle}
            testID="pr-review-comment-fix"
          >
            <Text style={fixTextStyle}>
              {t(
                selectedCount === 1
                  ? "workspace.git.pr.reviewComments.fixWithAgent"
                  : "workspace.git.pr.reviewComments.fixWithAgentPlural",
                { count: selectedCount },
              )}
            </Text>
          </Pressable>
        </View>
      ) : null}
    </View>
  );
}

// __STYLES__

const styles = StyleSheet.create((theme) => ({
  root: {
    flexShrink: 1,
    minHeight: 0,
    maxHeight: "55%",
    backgroundColor: theme.colors.surfaceSidebar,
  },
  divider: {
    height: 1,
    backgroundColor: theme.colors.border,
  },
  titleRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
  },
  title: {
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.normal,
    color: theme.colors.foregroundMuted,
  },
  notice: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    lineHeight: 16,
  },
  noticeBlock: {
    gap: theme.spacing[1],
    paddingBottom: theme.spacing[2],
  },
  retryButton: {
    alignSelf: "flex-start",
    marginHorizontal: theme.spacing[3],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[1],
    borderRadius: theme.borderRadius.sm,
    backgroundColor: theme.colors.surfaceSidebarHover,
  },
  retryText: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.foreground,
  },
  list: {
    flexShrink: 1,
    minHeight: 0,
  },
  listContent: {
    paddingBottom: theme.spacing[2],
  },
  hoverable: {
    backgroundColor: theme.colors.surfaceSidebarHover,
  },
  fileGroupHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
  },
  fileGroupPath: {
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foreground,
    flexShrink: 1,
  },
  threadRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: theme.spacing[2],
    paddingLeft: theme.spacing[6],
    paddingRight: theme.spacing[3],
    paddingVertical: theme.spacing[2],
  },
  threadMain: {
    flex: 1,
    minWidth: 0,
    gap: 3,
  },
  threadHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  threadReviewer: {
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foreground,
    flexShrink: 1,
  },
  threadMeta: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
  },
  threadBody: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
    lineHeight: 16,
  },
  diffHunk: {
    borderRadius: theme.borderRadius.sm,
    backgroundColor: theme.colors.surfaceDiffEmpty,
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1],
  },
  diffLine: {
    fontSize: theme.fontSize.code,
    fontFamily: theme.fontFamily.mono,
    lineHeight: theme.lineHeight.diff,
  },
  diffCode: {
    color: theme.colors.foreground,
  },
  diffMuted: {
    color: theme.colors.foregroundMuted,
  },
  diffAdd: {
    color: theme.colors.statusSuccess,
  },
  diffRemove: {
    color: theme.colors.statusDanger,
  },
  checkbox: {
    width: 16,
    height: 16,
    borderRadius: theme.borderRadius.sm,
    borderWidth: 1,
    borderColor: theme.colors.border,
    marginTop: 1,
  },
  checkboxSelected: {
    width: 16,
    height: 16,
    borderRadius: theme.borderRadius.sm,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: theme.colors.accent,
    marginTop: 1,
  },
  checkIconColor: {
    color: theme.colors.accentForeground,
  },
  actionBar: {
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    borderTopWidth: 1,
    borderTopColor: theme.colors.border,
  },
  actionHint: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
  },
  fixButton: {
    alignItems: "center",
    paddingVertical: theme.spacing[2],
    borderRadius: theme.borderRadius.sm,
    backgroundColor: theme.colors.accent,
  },
  fixButtonDisabled: {
    backgroundColor: theme.colors.surfaceSidebarHover,
  },
  fixText: {
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.accentForeground,
  },
  fixTextDisabled: {
    color: theme.colors.foregroundMuted,
  },
}));
