import { View, Text } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import type { ParsedDiffFile } from "@getpaseo/protocol/messages";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { useCommitFileDiff } from "@/git/use-commit-file-diff";
import { DiffFileBody } from "@/git/diff-file-body";
import { useAppSettings } from "@/hooks/use-settings";
import { useChangesPreferences } from "@/hooks/use-changes-preferences";
import { useIsCompactFormFactor } from "@/constants/layout";
import { isWeb } from "@/constants/platform";

const ThemedLoadingSpinner = withUnistyles(LoadingSpinner);

interface CommitFileDiffViewProps {
  serverId: string;
  cwd: string;
  sha: string;
  path: string;
}

// Renders the per-commit file diff through the same DiffFileBody the Changes
// panel uses, so the two stay pixel-identical across unified/split and
// wrap/no-wrap. Layout and wrap come from the shared Changes preferences, mirroring
// GitDiffPane: split is only available on non-compact web; otherwise unified.
// No reviewActions are passed — the per-commit view has no inline-review affordances.
function CommitFileDiffBody({ file }: { file: ParsedDiffFile }) {
  const { settings } = useAppSettings();
  const { preferences } = useChangesPreferences();
  const isCompact = useIsCompactFormFactor();
  const wrapLines = preferences.wrapLines;
  const layout = isWeb && !isCompact ? preferences.layout : "unified";

  return (
    <DiffFileBody
      file={file}
      layout={layout}
      wrapLines={wrapLines}
      codeFontSize={settings.codeFontSize}
    />
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
    <View testID={`commit-file-diff-${path}`}>
      <CommitFileDiffContent file={file} isLoading={isLoading} error={error} />
    </View>
  );
}

const spinnerColorMapping = (theme: { colors: { foregroundMuted: string } }) => ({
  color: theme.colors.foregroundMuted,
});

const styles = StyleSheet.create((theme) => ({
  statusRow: {
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    alignItems: "flex-start",
  },
  message: {
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[1],
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
  },
  error: {
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[1],
    fontSize: theme.fontSize.xs,
    color: theme.colors.statusDanger,
  },
}));
