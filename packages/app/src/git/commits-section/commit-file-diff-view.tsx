import { useCallback, useMemo, useState } from "react";
import { ScrollView, View, Text, type LayoutChangeEvent } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import type { ParsedDiffFile } from "@getpaseo/protocol/messages";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { buildUnifiedDiffLines } from "@/utils/diff-layout";
import { useCommitFileDiff } from "@/git/use-commit-file-diff";
import { DiffUnifiedLineRow } from "@/git/diff-unified-line-row";
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

function CommitFileDiffBody({ file }: { file: ParsedDiffFile }) {
  const { t } = useTranslation();
  const { settings } = useAppSettings();
  const codeFontSize = settings.codeFontSize;
  // Measured row min-width: short lines stretch to fill the viewport so the
  // line-type background spans the full row (matching the Changes diff), while
  // long lines still overflow into the horizontal scroll.
  const [contentMinWidth, setContentMinWidth] = useState(0);
  const lines = useMemo(() => buildUnifiedDiffLines(file), [file]);
  const gutterWidth = useMemo(() => {
    let maxLineNo = 0;
    for (const hunk of file.hunks) {
      maxLineNo = Math.max(maxLineNo, hunk.oldStart + hunk.oldCount, hunk.newStart + hunk.newCount);
    }
    return lineNumberGutterWidth(maxLineNo, codeFontSize);
  }, [file, codeFontSize]);

  const linesContainerStyle = useMemo(
    () => [
      styles.lines,
      contentMinWidth > 0 && inlineUnistylesStyle({ minWidth: contentMinWidth }),
    ],
    [contentMinWidth],
  );

  const handleLayout = useCallback((event: LayoutChangeEvent) => {
    setContentMinWidth(event.nativeEvent.layout.width);
  }, []);

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
    <ScrollView horizontal showsHorizontalScrollIndicator={false} onLayout={handleLayout}>
      <View style={linesContainerStyle}>
        {lines.map((entry) => (
          // wrapLines is intentionally false: the commit file diff lives inside a
          // horizontal ScrollView, so lines scroll rather than wrap. The row is
          // rendered through the shared DiffUnifiedLineRow so it stays identical
          // to the Changes diff. No review props here — the per-commit view has
          // no inline-review affordances.
          <DiffUnifiedLineRow
            key={entry.key}
            line={entry.line}
            lineNumber={entry.lineNumber}
            gutterWidth={gutterWidth}
            wrapLines={false}
          />
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
