import { useCallback, useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { useChangesPreferences } from "@/hooks/use-changes-preferences";
import { useCheckoutCommitsQuery } from "@/git/use-commits-query";
import { ThemedChevron, chevronColorMapping } from "@/git/themed-chevron";
import { CommitRow } from "./commit-row";
import type { FilePressHandler } from "./shared";

interface CommitsSectionProps {
  serverId: string;
  cwd: string;
  onFilePress?: FilePressHandler;
}

export function CommitsSection({ serverId, cwd, onFilePress }: CommitsSectionProps) {
  const { t } = useTranslation();
  const { commits, capabilityMissing } = useCheckoutCommitsQuery({ serverId, cwd });
  const { preferences, updatePreferences } = useChangesPreferences();
  const collapsed = preferences.commitsCollapsed;
  const [expandedShas, setExpandedShas] = useState<ReadonlySet<string>>(() => new Set());

  const handleToggleSection = useCallback(() => {
    void updatePreferences({ commitsCollapsed: !collapsed });
  }, [collapsed, updatePreferences]);

  const handleToggleCommit = useCallback((sha: string) => {
    setExpandedShas((prev) => {
      const next = new Set(prev);
      if (next.has(sha)) {
        next.delete(sha);
      } else {
        next.add(sha);
      }
      return next;
    });
  }, []);

  const headerChevronStyle = useMemo(
    () => [styles.headerChevron, !collapsed && styles.headerChevronExpanded],
    [collapsed],
  );

  if (capabilityMissing || commits.length === 0) {
    return null;
  }

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
        <Text
          style={styles.count}
          accessibilityLabel={t("workspace.git.diff.commits.countLabel", {
            count: commits.length,
          })}
        >
          {commits.length}
        </Text>
        <View style={styles.legend}>
          <View style={styles.dotLocal} />
          <Text style={styles.legendText}>{t("workspace.git.diff.commits.legendLocal")}</Text>
          <View style={styles.dotRemote} />
          <Text style={styles.legendText}>{t("workspace.git.diff.commits.legendRemote")}</Text>
        </View>
      </Pressable>
      {collapsed ? null : (
        <View style={styles.list}>
          {commits.map((commit) => (
            <CommitRow
              key={commit.sha}
              commit={commit}
              expanded={expandedShas.has(commit.sha)}
              serverId={serverId}
              cwd={cwd}
              onToggle={handleToggleCommit}
              onFilePress={onFilePress}
            />
          ))}
        </View>
      )}
    </View>
  );
}

const LEGEND_DOT_SIZE = 8;

const styles = StyleSheet.create((theme) => ({
  container: {
    borderBottomWidth: theme.borderWidth[1],
    borderBottomColor: theme.colors.border,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingLeft: theme.spacing[2],
    paddingRight: theme.spacing[3],
    paddingVertical: theme.spacing[2],
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
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foreground,
  },
  count: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
    flex: 1,
  },
  legend: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    flexShrink: 0,
  },
  legendText: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
  },
  dotLocal: {
    width: LEGEND_DOT_SIZE,
    height: LEGEND_DOT_SIZE,
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.statusSuccess,
  },
  dotRemote: {
    width: LEGEND_DOT_SIZE,
    height: LEGEND_DOT_SIZE,
    borderRadius: theme.borderRadius.full,
    backgroundColor: "transparent",
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.foregroundMuted,
    marginLeft: theme.spacing[1],
  },
  list: {
    paddingBottom: theme.spacing[1],
  },
}));
