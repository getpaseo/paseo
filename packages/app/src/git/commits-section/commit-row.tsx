import { memo, useCallback, useEffect, useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import type { CheckoutCommit } from "@getpaseo/protocol/messages";
import { ThemedChevron, chevronColorMapping } from "@/git/themed-chevron";
import { CommitFileList } from "./commit-file-list";
import { type FilePressHandler, dotStyles } from "./shared";

interface CommitRowProps {
  commit: CheckoutCommit;
  expanded: boolean;
  serverId: string;
  cwd: string;
  fileView: "list" | "tree";
  onToggle: (sha: string) => void;
  onFilePress?: FilePressHandler;
}

export const CommitRow = memo(function CommitRow({
  commit,
  expanded,
  serverId,
  cwd,
  fileView,
  onToggle,
  onFilePress,
}: CommitRowProps) {
  const [openFilePath, setOpenFilePath] = useState<string | null>(null);

  // Reset the inline diff when the commit collapses so re-expanding doesn't
  // auto-reopen the previously selected file.
  useEffect(() => {
    if (!expanded) {
      setOpenFilePath(null);
    }
  }, [expanded]);

  const chevronStyle = useMemo(
    () => [styles.chevron, expanded && styles.chevronExpanded],
    [expanded],
  );

  const handleToggle = useCallback(() => {
    onToggle(commit.sha);
  }, [commit.sha, onToggle]);

  // Stable across renders: toggles the inline diff for the pressed file and
  // forwards the press to any external listener. Keeping it stable preserves
  // CommitFileRow memoization (only the toggled rows re-render).
  const handleFilePress = useCallback<FilePressHandler>(
    (pressedCommit, file) => {
      setOpenFilePath((prev) => (prev === file.path ? null : file.path));
      onFilePress?.(pressedCommit, file);
    },
    [onFilePress],
  );

  return (
    <View>
      <Pressable
        accessibilityRole="button"
        testID={`commit-row-${commit.shortSha}`}
        onPress={handleToggle}
        style={styles.row}
      >
        <View style={chevronStyle}>
          <ThemedChevron size={14} uniProps={chevronColorMapping} />
        </View>
        <View
          testID={commit.isOnRemote ? "commit-dot-remote" : "commit-dot-local"}
          style={commit.isOnRemote ? dotStyles.dotRemote : dotStyles.dotLocal}
        />
        <Text style={styles.shortSha}>{commit.shortSha}</Text>
        <Text style={styles.subject} numberOfLines={1}>
          {commit.subject}
        </Text>
      </Pressable>
      {expanded ? (
        <CommitFileList
          commit={commit}
          fileView={fileView}
          serverId={serverId}
          cwd={cwd}
          openFilePath={openFilePath}
          onFilePress={handleFilePress}
        />
      ) : null}
    </View>
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
  chevron: {
    width: 16,
    height: 16,
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },
  chevronExpanded: {
    transform: [{ rotate: "90deg" }],
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
}));
