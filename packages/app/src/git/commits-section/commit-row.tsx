import { memo, useCallback } from "react";
import { Pressable, Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import type { CheckoutCommit } from "@getpaseo/protocol/messages";
import { ThemedChevron, chevronColorMapping } from "@/git/themed-chevron";
import { dotStyles } from "./shared";

interface CommitRowProps {
  commit: CheckoutCommit;
  onCommitPress: (sha: string) => void;
}

export const CommitRow = memo(function CommitRow({ commit, onCommitPress }: CommitRowProps) {
  const handlePress = useCallback(() => {
    onCommitPress(commit.sha);
  }, [commit.sha, onCommitPress]);

  return (
    <Pressable
      accessibilityRole="button"
      testID={`commit-row-${commit.shortSha}`}
      onPress={handlePress}
      style={styles.row}
    >
      <View
        testID={commit.isOnRemote ? "commit-dot-remote" : "commit-dot-local"}
        style={commit.isOnRemote ? dotStyles.dotRemote : dotStyles.dotLocal}
      />
      <Text style={styles.shortSha}>{commit.shortSha}</Text>
      <Text style={styles.subject} numberOfLines={1}>
        {commit.subject}
      </Text>
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
  shortSha: {
    fontSize: theme.fontSize.xs,
    fontFamily: theme.fontFamily.mono,
    color: theme.colors.foregroundMuted,
    flexShrink: 0,
  },
  subject: {
    flex: 1,
    minWidth: 0,
    fontSize: theme.fontSize.sm,
    color: theme.colors.foreground,
  },
  caret: {
    width: 16,
    height: 16,
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },
}));
