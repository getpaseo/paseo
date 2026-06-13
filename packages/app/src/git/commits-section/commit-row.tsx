import { memo, useCallback, useMemo } from "react";
import { Pressable, Text, View } from "react-native";
import { SvgXml } from "react-native-svg";
import { StyleSheet } from "react-native-unistyles";
import type { CheckoutCommit } from "@getpaseo/protocol/messages";
import { DiffStat } from "@/components/diff-stat";
import { getFileIconSvg } from "@/components/material-file-icons";
import { ThemedChevron, chevronColorMapping } from "@/git/themed-chevron";
import type { CheckoutCommitFile, FilePressHandler } from "./shared";

interface CommitFileRowProps {
  commit: CheckoutCommit;
  file: CheckoutCommitFile;
  onFilePress?: FilePressHandler;
}

const CommitFileRow = memo(function CommitFileRow({
  commit,
  file,
  onFilePress,
}: CommitFileRowProps) {
  const handlePress = useCallback(() => {
    onFilePress?.(commit, file);
  }, [commit, file, onFilePress]);

  return (
    <Pressable
      accessibilityRole="button"
      testID={`commit-file-${file.path}`}
      onPress={handlePress}
      style={styles.fileRow}
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
  onToggle: (sha: string) => void;
  onFilePress?: FilePressHandler;
}

export const CommitRow = memo(function CommitRow({
  commit,
  expanded,
  onToggle,
  onFilePress,
}: CommitRowProps) {
  const chevronStyle = useMemo(
    () => [styles.chevron, expanded && styles.chevronExpanded],
    [expanded],
  );

  const handleToggle = useCallback(() => {
    onToggle(commit.sha);
  }, [commit.sha, onToggle]);

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
          style={commit.isOnRemote ? styles.dotRemote : styles.dotLocal}
        />
        <Text style={styles.shortSha}>{commit.shortSha}</Text>
        <Text style={styles.subject} numberOfLines={1}>
          {commit.subject}
        </Text>
      </Pressable>
      {expanded ? (
        <View style={styles.files}>
          {commit.files.map((file) => (
            <CommitFileRow key={file.path} commit={commit} file={file} onFilePress={onFilePress} />
          ))}
        </View>
      ) : null}
    </View>
  );
});

const DOT_SIZE = 8;

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
  dotLocal: {
    width: DOT_SIZE,
    height: DOT_SIZE,
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.statusSuccess,
    flexShrink: 0,
  },
  dotRemote: {
    width: DOT_SIZE,
    height: DOT_SIZE,
    borderRadius: theme.borderRadius.full,
    backgroundColor: "transparent",
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.foregroundMuted,
    flexShrink: 0,
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
