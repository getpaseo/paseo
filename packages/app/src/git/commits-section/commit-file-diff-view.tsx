import { memo, useMemo } from "react";
import { ScrollView, Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import type { ParsedDiffFile } from "@getpaseo/protocol/messages";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { buildUnifiedDiffLines, type UnifiedDiffDisplayLine } from "@/utils/diff-layout";
import {
  formatDiffContentText,
  formatDiffGutterText,
  hasVisibleDiffTokens,
} from "@/utils/diff-rendering";
import { useCommitFileDiff } from "@/git/use-commit-file-diff";
import { HighlightedText } from "@/git/diff-highlighted-text";
import { lineNumberGutterWidth } from "@/components/code-insets";
import { inlineUnistylesStyle } from "@/styles/unistyles-inline-style";
import { useAppSettings } from "@/hooks/use-settings";

const ThemedLoadingSpinner = withUnistyles(LoadingSpinner);

interface CommitFileDiffViewProps {
  serverId: string;
  cwd: string;
  sha: string;
  path: string;
}

function lineContainerStyle(type: UnifiedDiffDisplayLine["line"]["type"]) {
  if (type === "add") return styles.addLine;
  if (type === "remove") return styles.removeLine;
  if (type === "header") return styles.headerLine;
  return styles.contextLine;
}

const DiffLineRow = memo(function DiffLineRow({
  entry,
  gutterWidth,
}: {
  entry: UnifiedDiffDisplayLine;
  gutterWidth: number;
}) {
  const { line, lineNumber } = entry;
  const containerStyle = useMemo(() => [styles.line, lineContainerStyle(line.type)], [line.type]);
  const gutterStyle = useMemo(
    () => [
      styles.gutter,
      inlineUnistylesStyle({ width: gutterWidth }),
      line.type === "add" && styles.addGutterText,
      line.type === "remove" && styles.removeGutterText,
    ],
    [line.type, gutterWidth],
  );
  const textStyle = useMemo(
    () => [
      styles.lineText,
      line.type === "add" && styles.addLineText,
      line.type === "remove" && styles.removeLineText,
      (line.type === "context" || line.type === "header") && styles.mutedLineText,
    ],
    [line.type],
  );
  const visibleTokens = hasVisibleDiffTokens(line.tokens) ? line.tokens : null;
  return (
    <View style={containerStyle}>
      <Text style={gutterStyle} numberOfLines={1}>
        {formatDiffGutterText(lineNumber)}
      </Text>
      {line.type !== "header" && visibleTokens ? (
        // wrapLines is intentionally omitted: the commit file diff lives inside a
        // horizontal ScrollView, so lines scroll rather than wrap.
        <HighlightedText tokens={visibleTokens} />
      ) : (
        <Text style={textStyle}>{formatDiffContentText(line.content)}</Text>
      )}
    </View>
  );
});

function CommitFileDiffBody({ file }: { file: ParsedDiffFile }) {
  const { t } = useTranslation();
  const { settings } = useAppSettings();
  const codeFontSize = settings.codeFontSize;
  const lines = useMemo(() => buildUnifiedDiffLines(file), [file]);
  const gutterWidth = useMemo(() => {
    let maxLineNo = 0;
    for (const hunk of file.hunks) {
      maxLineNo = Math.max(maxLineNo, hunk.oldStart + hunk.oldCount, hunk.newStart + hunk.newCount);
    }
    return lineNumberGutterWidth(maxLineNo, codeFontSize);
  }, [file, codeFontSize]);

  if (file.status === "binary") {
    return <Text style={styles.message}>{t("workspace.git.diff.binaryFile")}</Text>;
  }
  if (file.status === "too_large") {
    return <Text style={styles.message}>{t("workspace.git.diff.tooLarge")}</Text>;
  }
  if (lines.length === 0) {
    return <Text style={styles.message}>{t("workspace.git.diff.commits.fileDiffEmpty")}</Text>;
  }

  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false}>
      <View style={styles.lines}>
        {lines.map((entry) => (
          <DiffLineRow key={entry.key} entry={entry} gutterWidth={gutterWidth} />
        ))}
      </View>
    </ScrollView>
  );
}

function CommitFileDiffContent({
  file,
  isLoading,
  error,
}: {
  file: ParsedDiffFile | null;
  isLoading: boolean;
  error: Error | null;
}) {
  const { t } = useTranslation();

  if (isLoading) {
    return (
      <View style={styles.statusRow}>
        <ThemedLoadingSpinner uniProps={spinnerColorMapping} />
      </View>
    );
  }
  if (error) {
    return <Text style={styles.error}>{t("workspace.git.diff.commits.fileDiffError")}</Text>;
  }
  if (file) {
    return <CommitFileDiffBody file={file} />;
  }
  return <Text style={styles.message}>{t("workspace.git.diff.commits.fileDiffEmpty")}</Text>;
}

export function CommitFileDiffView({ serverId, cwd, sha, path }: CommitFileDiffViewProps) {
  const { file, isLoading, error } = useCommitFileDiff({ serverId, cwd, sha, path });

  return (
    <View style={styles.container} testID={`commit-file-diff-${path}`}>
      <CommitFileDiffContent file={file} isLoading={isLoading} error={error} />
    </View>
  );
}

const spinnerColorMapping = (theme: { colors: { foregroundMuted: string } }) => ({
  color: theme.colors.foregroundMuted,
});

const styles = StyleSheet.create((theme) => ({
  container: {
    paddingLeft: theme.spacing[3],
    paddingRight: theme.spacing[2],
    paddingVertical: theme.spacing[1],
  },
  statusRow: {
    paddingVertical: theme.spacing[2],
    alignItems: "flex-start",
  },
  lines: {
    flexDirection: "column",
  },
  line: {
    flexDirection: "row",
    alignItems: "flex-start",
  },
  gutter: {
    textAlign: "right",
    paddingRight: theme.spacing[2],
    fontSize: theme.fontSize.code,
    lineHeight: theme.lineHeight.diff,
    fontFamily: theme.fontFamily.mono,
    color: theme.colors.foregroundMuted,
  },
  addGutterText: {
    color: theme.colors.diffAddition,
  },
  removeGutterText: {
    color: theme.colors.diffDeletion,
  },
  lineText: {
    paddingRight: theme.spacing[3],
    fontSize: theme.fontSize.code,
    lineHeight: theme.lineHeight.diff,
    fontFamily: theme.fontFamily.mono,
    color: theme.colors.foreground,
  },
  addLine: {
    backgroundColor: "rgba(46, 160, 67, 0.15)",
  },
  removeLine: {
    backgroundColor: "rgba(248, 81, 73, 0.1)",
  },
  headerLine: {
    backgroundColor: theme.colors.surface2,
  },
  contextLine: {
    backgroundColor: theme.colors.surface1,
  },
  addLineText: {
    color: theme.colors.foreground,
  },
  removeLineText: {
    color: theme.colors.foreground,
  },
  mutedLineText: {
    color: theme.colors.foregroundMuted,
  },
  message: {
    paddingVertical: theme.spacing[1],
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
  },
  error: {
    paddingVertical: theme.spacing[1],
    fontSize: theme.fontSize.xs,
    color: theme.colors.statusDanger,
  },
}));
