import { memo, useCallback } from "react";
import { Pressable, Text, View, type PressableStateCallbackType } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import type { CommitLogEntry } from "@getpaseo/protocol/messages";
import { CODE_SURFACE_DATASET } from "@/styles/code-surface";
import { formatCompactTimeAgo } from "@/utils/time";
import { CommitRefBadges } from "./commit-ref-badges";

interface CommitLogRowProps {
  commit: CommitLogEntry;
  now: Date;
  showAuthor: boolean;
  onPress: (sha: string) => void;
}

function commitLogRowStyle({
  hovered,
  pressed,
}: PressableStateCallbackType & { hovered?: boolean }) {
  return [styles.row, (Boolean(hovered) || pressed) && styles.rowActive];
}

export const CommitLogRow = memo(function CommitLogRow({
  commit,
  now,
  showAuthor,
  onPress,
}: CommitLogRowProps) {
  const handlePress = useCallback(() => onPress(commit.sha), [commit.sha, onPress]);

  return (
    <Pressable
      accessibilityRole="button"
      testID={`commit-log-row-${commit.shortSha}`}
      onPress={handlePress}
      style={commitLogRowStyle}
    >
      {/* Same fixed width as the commits section so the two lists align. */}
      <Text dataSet={CODE_SURFACE_DATASET} style={styles.shortSha} numberOfLines={1}>
        {commit.shortSha}
      </Text>
      <Text style={styles.subject} numberOfLines={1}>
        {commit.subject}
      </Text>
      <CommitRefBadges refs={commit.refs} />
      {showAuthor ? (
        <Text style={styles.author} numberOfLines={1}>
          {commit.authorName}
        </Text>
      ) : null}
      <View style={styles.timestamp}>
        <Text style={styles.timestampText} numberOfLines={1}>
          {formatCompactTimeAgo(new Date(commit.authorDate), now)}
        </Text>
      </View>
    </Pressable>
  );
});

const styles = StyleSheet.create((theme) => ({
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1],
    // A commit with badges and one without occupy the same box.
    minHeight: 28,
  },
  rowActive: {
    backgroundColor: theme.colors.surfaceSidebarHover,
  },
  shortSha: {
    fontSize: theme.fontSize.sm,
    fontFamily: theme.fontFamily.mono,
    color: theme.colors.foregroundMuted,
    width: 70,
    flexShrink: 0,
  },
  subject: {
    flex: 1,
    minWidth: 0,
    fontSize: theme.fontSize.base,
    color: theme.colors.foreground,
  },
  author: {
    flexShrink: 0,
    maxWidth: 120,
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
  timestamp: {
    flexShrink: 0,
    // Fixed rail so relative times of different lengths do not jitter the row.
    width: 56,
    alignItems: "flex-end",
  },
  timestampText: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
}));
