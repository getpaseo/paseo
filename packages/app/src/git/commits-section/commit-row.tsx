import { memo, useCallback } from "react";
import { Pressable, Text, View, type PressableStateCallbackType } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { ThemedChevron, chevronColorMapping } from "@/git/themed-chevron";
import type { ClassifiedCheckoutCommit } from "@/git/use-commits-query";
import { CODE_SURFACE_DATASET } from "@/styles/code-surface";
import { formatTimeAgo } from "@/utils/time";
import { CommitGraphNode } from "./commit-graph-node";

interface CommitRowProps {
  commit: ClassifiedCheckoutCommit;
  isFirst: boolean;
  isLast: boolean;
  now: Date;
  onCommitPress: (sha: string) => void;
}

function commitRowPressableStyle({
  hovered,
  pressed,
}: PressableStateCallbackType & { hovered?: boolean }) {
  return [styles.row, (Boolean(hovered) || pressed) && styles.rowActive];
}

export const CommitRow = memo(function CommitRow({
  commit,
  isFirst,
  isLast,
  now,
  onCommitPress,
}: CommitRowProps) {
  const handlePress = useCallback(() => {
    onCommitPress(commit.sha);
  }, [commit.sha, onCommitPress]);

  return (
    <Pressable
      accessibilityRole="button"
      testID={`commit-row-${commit.shortSha}`}
      onPress={handlePress}
      style={commitRowPressableStyle}
    >
      <CommitGraphNode commit={commit} isFirst={isFirst} isLast={isLast} />
      <View style={styles.commitDetails}>
        <Text dataSet={CODE_SURFACE_DATASET} style={styles.shortSha} numberOfLines={1}>
          {commit.shortSha}
        </Text>
        <Text style={styles.subject} numberOfLines={1}>
          {commit.subject}
        </Text>
      </View>
      <Text style={styles.timestamp}>{formatTimeAgo(new Date(commit.authorDate), now)}</Text>
      <View style={styles.caret}>
        <ThemedChevron size={14} uniProps={chevronColorMapping} />
      </View>
    </Pressable>
  );
});

const styles = StyleSheet.create((theme) => ({
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingLeft: theme.spacing[2],
    paddingRight: theme.spacing[2],
    paddingVertical: theme.spacing[1],
  },
  rowActive: {
    backgroundColor: theme.colors.surfaceSidebarHover,
  },
  commitDetails: {
    flex: 1,
    minWidth: 0,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
  },
  shortSha: {
    fontSize: theme.fontSize.xs,
    fontFamily: theme.fontFamily.mono,
    color: theme.colors.foregroundMuted,
    width: 70,
    flexShrink: 0,
  },
  subject: {
    flex: 1,
    minWidth: 0,
    fontSize: theme.fontSize.sm,
    color: theme.colors.foreground,
  },
  timestamp: {
    flexShrink: 0,
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
  },
  caret: {
    width: 16,
    height: 16,
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },
}));
