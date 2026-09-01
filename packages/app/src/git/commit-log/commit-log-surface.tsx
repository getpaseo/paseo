import { useCallback, useEffect, useMemo, useState } from "react";
import { ScrollView, Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import type { CommitLogScope } from "@getpaseo/protocol/messages";
import { Button } from "@/components/ui/button";
import { useRetainedPanelActive } from "@/components/retained-panel";
import { useContainerWidthBelow } from "@/hooks/use-container-width";
import { CommitLogRow } from "./commit-log-row";
import { CommitLogToolbar } from "./commit-log-toolbar";
import { useCommitLogQuery } from "./use-commit-log-query";

// Below this the author column crowds the subject out on a sidebar-width pane.
const COMMIT_LOG_AUTHOR_MIN_WIDTH = 560;
const SKELETON_ROWS = 6;

interface CommitLogSurfaceProps {
  serverId: string;
  cwd: string;
  scope: CommitLogScope;
  onScopeChange: (scope: CommitLogScope) => void;
  onCommitPress: (sha: string) => void;
  compact: boolean;
}

function CommitLogSkeleton() {
  const { t } = useTranslation();
  return (
    <View
      accessible
      accessibilityLabel={t("panels.commitLog.loading")}
      testID="commit-log-skeleton"
    >
      {Array.from({ length: SKELETON_ROWS }, (_, index) => (
        <View key={index} style={styles.skeletonRow}>
          <View style={styles.skeletonSha} />
          <View style={styles.skeletonSubject} />
          <View style={styles.skeletonTimestamp} />
        </View>
      ))}
    </View>
  );
}

function CenteredMessage({
  message,
  tone = "muted",
  testID,
  action,
}: {
  message: string;
  tone?: "muted" | "error";
  testID?: string;
  action?: { label: string; onPress: () => void };
}) {
  return (
    <View style={styles.centerState} testID={testID}>
      <Text style={tone === "error" ? styles.errorText : styles.mutedText}>{message}</Text>
      {action ? (
        <Button variant="ghost" size="sm" onPress={action.onPress} testID="commit-log-retry">
          {action.label}
        </Button>
      ) : null}
    </View>
  );
}

export function CommitLogSurface({
  serverId,
  cwd,
  scope,
  onScopeChange,
  onCommitPress,
  compact,
}: CommitLogSurfaceProps) {
  const { t } = useTranslation();
  const isPanelActive = useRetainedPanelActive();
  const { onLayout, isBelow } = useContainerWidthBelow(COMMIT_LOG_AUTHOR_MIN_WIDTH);
  const { result, loadMore, refresh, isRefreshing, didResetAfterExpiry, acknowledgeReset } =
    useCommitLogQuery({ serverId, cwd, scope });

  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    if (!isPanelActive) {
      return;
    }
    setNow(new Date());
    const interval = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(interval);
  }, [isPanelActive]);

  const handleScopeChange = useCallback(
    (next: CommitLogScope) => {
      acknowledgeReset();
      onScopeChange(next);
    },
    [acknowledgeReset, onScopeChange],
  );

  const retryAction = useMemo(
    () => ({ label: t("common.actions.retry"), onPress: refresh }),
    [refresh, t],
  );

  const notice = useMemo(() => {
    if (didResetAfterExpiry) {
      return t("panels.commitLog.cursorExpired");
    }
    if (result.status === "loaded" && result.data.pinnedTipsTruncated) {
      return t("panels.commitLog.truncatedRefs");
    }
    return null;
  }, [didResetAfterExpiry, result, t]);

  if (result.status === "unsupported") {
    return (
      <View style={styles.container} testID="commit-log-surface">
        <CenteredMessage
          message={t("panels.commitLog.capabilityMissing")}
          testID="commit-log-capability-missing"
        />
      </View>
    );
  }

  let body;
  if (result.status === "connecting") {
    body = <CenteredMessage message={t("panels.commitLog.connecting")} />;
  } else if (result.status === "loading") {
    body = <CommitLogSkeleton />;
  } else if (result.status === "error") {
    body = (
      <CenteredMessage
        message={t("panels.commitLog.loadError")}
        tone="error"
        testID="commit-log-error"
        action={retryAction}
      />
    );
  } else if (result.data.commits.length === 0) {
    body = <CenteredMessage message={t("panels.commitLog.empty")} testID="commit-log-empty" />;
  } else {
    body = (
      <>
        {result.data.commits.map((commit) => (
          <CommitLogRow
            key={commit.sha}
            commit={commit}
            now={now}
            showAuthor={!isBelow}
            onPress={onCommitPress}
          />
        ))}
        {result.data.hasMore ? (
          <View style={styles.loadMoreRow}>
            <Button
              variant="ghost"
              size="sm"
              disabled={result.isLoadingMore}
              onPress={loadMore}
              testID="commit-log-load-more"
            >
              {result.isLoadingMore
                ? t("panels.commitLog.loadingMore")
                : t("panels.commitLog.loadMore")}
            </Button>
          </View>
        ) : null}
      </>
    );
  }

  return (
    <View style={styles.container} testID="commit-log-surface" onLayout={onLayout}>
      <CommitLogToolbar
        scope={scope}
        onScopeChange={handleScopeChange}
        onRefresh={refresh}
        isRefreshing={isRefreshing}
        compact={compact}
      />
      {notice ? (
        <Text style={styles.notice} testID="commit-log-notice">
          {notice}
        </Text>
      ) : null}
      <ScrollView style={styles.list} contentContainerStyle={styles.listContent}>
        {body}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
    minHeight: 0,
  },
  list: {
    flex: 1,
    minHeight: 0,
  },
  listContent: {
    paddingBottom: theme.spacing[2],
  },
  notice: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
    paddingHorizontal: theme.spacing[3],
    paddingBottom: theme.spacing[1],
  },
  centerState: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[6],
    paddingTop: theme.spacing[16],
  },
  mutedText: {
    fontSize: theme.fontSize.base,
    color: theme.colors.foregroundMuted,
    textAlign: "center",
  },
  errorText: {
    fontSize: theme.fontSize.base,
    color: theme.colors.destructive,
    textAlign: "center",
  },
  loadMoreRow: {
    alignItems: "center",
    paddingVertical: theme.spacing[2],
  },
  skeletonRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[2],
    minHeight: 28,
  },
  skeletonSha: {
    width: 70,
    height: 10,
    borderRadius: theme.borderRadius.sm,
    backgroundColor: theme.colors.surface2,
    flexShrink: 0,
  },
  skeletonSubject: {
    flex: 1,
    minWidth: 0,
    height: 12,
    borderRadius: theme.borderRadius.sm,
    backgroundColor: theme.colors.surface2,
  },
  skeletonTimestamp: {
    width: 40,
    height: 10,
    borderRadius: theme.borderRadius.sm,
    backgroundColor: theme.colors.surface2,
    flexShrink: 0,
  },
}));
