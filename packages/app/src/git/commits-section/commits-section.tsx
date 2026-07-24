import { useCallback, useEffect, useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { useRetainedPanelActive } from "@/components/retained-panel";
import { useChangesPreferences } from "@/hooks/use-changes-preferences";
import { useCheckoutCommitsQuery, type CheckoutCommitsQueryResult } from "@/git/use-commits-query";
import { ThemedChevron, chevronColorMapping } from "@/git/themed-chevron";
import { normalizeBranchOptionName } from "@/utils/branch-suggestions";
import { CommitRow } from "./commit-row";

interface CommitsSectionProps {
  serverId: string;
  cwd: string;
  onCommitPress: (sha: string) => void;
}

function CommitsSectionSkeleton() {
  const { t } = useTranslation();
  return (
    <View
      accessible
      accessibilityLabel={t("workspace.git.diff.commits.loading")}
      style={styles.skeleton}
      testID="commits-section-skeleton"
    >
      <View style={styles.skeletonRow}>
        <View style={styles.skeletonDot} />
        <View style={styles.skeletonSha} />
        <View style={styles.skeletonSubject} />
        <View style={styles.skeletonTimestamp} />
        <View style={styles.skeletonCaret} />
      </View>
    </View>
  );
}

function CommitsSectionContent({
  query,
  now,
  onCommitPress,
}: {
  query: Exclude<CheckoutCommitsQueryResult, { status: "unsupported" }>;
  now: Date;
  onCommitPress: (sha: string) => void;
}) {
  const { t } = useTranslation();
  if (query.status === "error") {
    return (
      <Text style={styles.errorRow} testID="commits-section-error">
        {t("workspace.git.diff.commits.loadError")}
      </Text>
    );
  }
  if (query.status !== "loaded") {
    return <CommitsSectionSkeleton />;
  }
  const workspaceCommits = query.data.commits.filter((commit) => !commit.isOnBase);
  const baseRef = normalizeBranchOptionName(query.data.baseRef) ?? t("workspace.git.diff.base");
  if (workspaceCommits.length === 0) {
    return (
      <View style={styles.noWorkspaceCommitsRow} testID="commits-section-no-workspace-commits">
        <Text style={styles.noWorkspaceCommitsText}>
          {t("workspace.git.diff.commits.noneAhead", { baseRef })}
        </Text>
      </View>
    );
  }
  return (
    <View style={styles.list}>
      {workspaceCommits.map((commit, index) => (
        <CommitRow
          key={commit.sha}
          commit={commit}
          isFirst={index === 0}
          isLast={index === workspaceCommits.length - 1}
          now={now}
          onCommitPress={onCommitPress}
        />
      ))}
    </View>
  );
}

export function CommitsSection({ serverId, cwd, onCommitPress }: CommitsSectionProps) {
  const { t } = useTranslation();
  const { preferences, updatePreferences } = useChangesPreferences();
  const isPanelActive = useRetainedPanelActive();
  const collapsed = preferences.commitsCollapsed;
  const [now, setNow] = useState(() => new Date());
  const displayNow = useMemo(() => (isPanelActive ? new Date() : now), [isPanelActive, now]);
  const query = useCheckoutCommitsQuery({
    serverId,
    cwd,
    enabled: !collapsed,
  });

  const handleToggleSection = useCallback(() => {
    if (collapsed) {
      setNow(new Date());
    }
    void updatePreferences({ commitsCollapsed: !collapsed });
  }, [collapsed, updatePreferences]);

  useEffect(() => {
    if (collapsed || !isPanelActive) {
      return;
    }
    const interval = setInterval(() => setNow(new Date()), 10_000);
    return () => clearInterval(interval);
  }, [collapsed, isPanelActive]);

  const headerChevronStyle = useMemo(
    () => [styles.headerChevron, !collapsed && styles.headerChevronExpanded],
    [collapsed],
  );

  if (query.status === "unsupported") {
    return null;
  }
  const commitCount =
    query.status === "loaded"
      ? query.data.commits.filter((commit) => !commit.isOnBase).length
      : null;

  return (
    <View style={styles.container}>
      <Pressable
        accessibilityRole="button"
        testID="commits-section-header"
        onPress={handleToggleSection}
        style={styles.header}
      >
        <View style={headerChevronStyle}>
          <ThemedChevron size={14} uniProps={chevronColorMapping} />
        </View>
        <Text style={styles.title}>{t("workspace.git.diff.commits.title")}</Text>
        {commitCount === null ? (
          <View style={styles.countSpacer} />
        ) : (
          <Text
            style={styles.count}
            accessibilityLabel={t("workspace.git.diff.commits.countLabel", {
              count: commitCount,
            })}
          >
            {commitCount}
          </Text>
        )}
      </Pressable>
      {collapsed ? null : (
        <CommitsSectionContent query={query} now={displayNow} onCommitPress={onCommitPress} />
      )}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    borderTopWidth: theme.borderWidth[1],
    borderTopColor: theme.colors.border,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingLeft: theme.spacing[2],
    paddingRight: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    flexShrink: 0,
  },
  headerChevron: {
    width: 16,
    height: 16,
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },
  headerChevronExpanded: {
    transform: [{ rotate: "90deg" }],
  },
  title: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foreground,
  },
  count: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
    flex: 1,
  },
  countSpacer: {
    flex: 1,
  },
  list: {
    paddingBottom: theme.spacing[1],
  },
  noWorkspaceCommitsRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingLeft: theme.spacing[2],
    paddingRight: theme.spacing[3],
    paddingTop: theme.spacing[1],
    paddingBottom: theme.spacing[2],
  },
  noWorkspaceCommitsText: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
  },
  errorRow: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.statusDanger,
    paddingLeft: theme.spacing[2],
    paddingRight: theme.spacing[3],
    paddingVertical: theme.spacing[2],
  },
  skeleton: {
    paddingBottom: theme.spacing[1],
    gap: theme.spacing[2],
  },
  skeletonRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1],
    minHeight: 20,
  },
  skeletonDot: {
    width: 8,
    height: 8,
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.surface2,
  },
  skeletonSha: {
    width: 48,
    height: 10,
    borderRadius: theme.borderRadius.sm,
    backgroundColor: theme.colors.surface2,
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
  skeletonCaret: {
    width: 16,
    height: 16,
    flexShrink: 0,
  },
}));
