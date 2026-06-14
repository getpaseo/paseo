import { memo, useCallback, useEffect, useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { SvgXml } from "react-native-svg";
import { StyleSheet } from "react-native-unistyles";
import type { CheckoutCommit } from "@getpaseo/protocol/messages";
import { DiffStat } from "@/components/diff-stat";
import { getFileIconSvg } from "@/components/material-file-icons";
import { ThemedChevron, chevronColorMapping } from "@/git/themed-chevron";
import { CommitFileDiffView } from "./commit-file-diff-view";
import { type CheckoutCommitFile, type FilePressHandler, dotStyles } from "./shared";

interface CommitFileRowProps {
  commit: CheckoutCommit;
  file: CheckoutCommitFile;
  isOpen: boolean;
  onFilePress: FilePressHandler;
}

const CommitFileRow = memo(function CommitFileRow({
  commit,
  file,
  isOpen,
  onFilePress,
}: CommitFileRowProps) {
  const handlePress = useCallback(() => {
    onFilePress(commit, file);
  }, [commit, file, onFilePress]);

  const rowStyle = useMemo(() => [styles.fileRow, isOpen && styles.fileRowOpen], [isOpen]);
  const accessibilityState = useMemo(() => ({ expanded: isOpen }), [isOpen]);

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={accessibilityState}
      testID={`commit-file-${file.path}`}
      onPress={handlePress}
      style={rowStyle}
    >
      <View style={styles.fileIcon}>
        <SvgXml xml={getFileIconSvg(file.path)} width={16} height={16} />
      </View>
      <Text style={styles.filePath} numberOfLines={1}>
        {file.path}
      </Text>
      <DiffStat additions={file.additions} deletions={file.deletions} />
    </Pressable>
  );
});

interface CommitRowProps {
  commit: CheckoutCommit;
  expanded: boolean;
  serverId: string;
  cwd: string;
  onToggle: (sha: string) => void;
  onFilePress?: FilePressHandler;
}

export const CommitRow = memo(function CommitRow({
  commit,
  expanded,
  serverId,
  cwd,
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
        <View style={styles.files}>
          {commit.files.map((file) => (
            <View key={file.path}>
              <CommitFileRow
                commit={commit}
                file={file}
                isOpen={openFilePath === file.path}
                onFilePress={handleFilePress}
              />
              {openFilePath === file.path ? (
                <CommitFileDiffView
                  serverId={serverId}
                  cwd={cwd}
                  sha={commit.sha}
                  path={file.path}
                />
              ) : null}
            </View>
          ))}
        </View>
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
  files: {
    paddingLeft: theme.spacing[3],
  },
  fileRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingLeft: theme.spacing[3],
    paddingRight: theme.spacing[2],
    paddingVertical: theme.spacing[1],
  },
  fileRowOpen: {
    backgroundColor: theme.colors.surface2,
  },
  fileIcon: {
    width: 16,
    height: 16,
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },
  filePath: {
    flex: 1,
    minWidth: 0,
    fontSize: theme.fontSize.sm,
    color: theme.colors.foreground,
  },
}));
